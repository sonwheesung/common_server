// GET /api/cron/info — 정보 허브 수집(일 1회, vercel.json crons). 설계는 `docs/INFO_HUB.md`.
//
// 인증은 `cron/purge`와 같은 **fail-closed** 규율이다(배포 환경에서 시크릿 없으면 거부).
//
// 🔴 이 라우트의 세 가지 규율:
//  ① **한 회차에 소스 N개만** 돈다(§5-2). 전부 돌면 서버리스 시간 제한에 걸리고 어디까지 됐는지도 모른다.
//  ② **소스 하나가 죽어도 나머지는 계속한다** — `allSettled`. `all`은 하나가 전체를 죽인다.
//  ③ **시도(`lastRunAt`)와 성공(`lastOkAt`)을 따로 남긴다**(§5-4). 하나만 두면
//     "돌았는데 0건"과 "실패해서 0건"이 화면에서 같아진다.
import { NextResponse } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../../../db';
import { infoItems, infoSources } from '../../../../db/schema';
import {
  ADAPTERS,
  FETCH_TIMEOUT_MS,
  ITEMS_PER_FETCH,
  MAX_SOURCES_PER_RUN,
  RUN_BUDGET_MS,
  SOURCE_BATCH,
  USER_AGENT,
  buildRequestUrl,
  findList,
  parseFeed,
  redact,
} from '../../../../lib/info';
import { reportError } from '../../../../lib/observability';

export const dynamic = 'force-dynamic';

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET ?? ''; // 호출 시점 읽기
  const isDeployed = process.env.VERCEL_ENV === 'production' || process.env.VERCEL_ENV === 'preview';
  if (!secret) return !isDeployed;
  return req.headers.get('authorization') === `Bearer ${secret}`;
}

type SourceRow = typeof infoSources.$inferSelect;

/** 소스 하나를 수집해 **새로 들어온 건수**를 돌려준다. 실패하면 던진다(호출부가 사유를 기록한다). */
async function collect(src: SourceRow): Promise<number> {
  const url = buildRequestUrl(src.config);
  // 🔴 "키 미설정"은 오류다. 조용히 0건 성공으로 넘기면 화면이 "새 공고 없음"으로 거짓말한다.
  if (!url) throw new Error(`요청 URL을 만들 수 없습니다 — config.endpoint 또는 키(env)가 비어 있습니다`);

  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      accept: 'application/json, application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8',
      // 🔴 User-Agent 를 안 보내면 **Reddit 이 429로 막는다**(2026-09-07 실측 — UA를 넣으면 200).
      //    누가 왜 부르는지 밝히는 게 예의이기도 하다. 연락처를 함께 둔다.
      'user-agent': USER_AGENT,
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const text = await res.text();

  // 응답이 JSON이면 목록을 찾아 들어가고, 아니면 RSS·Atom 피드로 읽는다.
  // ⚠ 둘 다 실패하면 **던진다**. 빈 배열로 바꾸면 "0건 성공"이 되어 화면이 거짓말한다.
  let rows: unknown[] | null = null;
  if (/^\s*[[{]/.test(text)) {
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`JSON처럼 시작했지만 파싱 실패: ${text.slice(0, 120)}`);
    }
    rows = findList(payload);
    if (!rows) throw new Error(`응답에서 목록을 찾지 못했습니다: ${JSON.stringify(payload).slice(0, 160)}`);
  } else {
    rows = parseFeed(text);
    if (!rows) throw new Error(`JSON도 피드도 아닙니다: ${text.slice(0, 140)}`);
  }

  const adapter = ADAPTERS[src.kind];
  if (!adapter) throw new Error(`알 수 없는 kind: ${src.kind}`);
  // 🔴 category 는 **소스가 정한다**(어댑터가 아니라). 어댑터는 응답만 알고 우리 분류는 모른다 —
  //    그래야 같은 어댑터로 여러 분류를 수집할 수 있다.
  const category = typeof (src.config as Record<string, unknown>).category === 'string'
    ? ((src.config as Record<string, unknown>).category as string)
    : null;
  const items = adapter(rows.slice(0, ITEMS_PER_FETCH)).map((it) => ({ ...it, category }));
  if (!items.length) throw new Error(`${rows.length}행을 받았지만 제목·링크를 읽지 못했습니다 — 어댑터 필드명 확인 필요`);

  // 멱등: `(source_id, external_id)` 유니크. 이미 있으면 제목·마감만 갱신하고 `read_at`은 건드리지 않는다
  // — 읽음 표시는 운영자의 상태이지 수집의 부수효과가 아니다(`CLAUDE.md`의 문의 상태 규약과 같은 계열).
  const inserted = await db
    .insert(infoItems)
    .values(items.map((it) => ({ ...it, sourceId: src.id, kind: src.kind })))
    .onConflictDoUpdate({
      target: [infoItems.sourceId, infoItems.externalId],
      set: {
        title: sql`excluded.title`,
        summary: sql`excluded.summary`,
        endsAt: sql`excluded.ends_at`,
        startsAt: sql`excluded.starts_at`,
        category: sql`excluded.category`,
        fetchedAt: new Date(),
      },
      setWhere: sql`${infoItems.title} is distinct from excluded.title or ${infoItems.endsAt} is distinct from excluded.ends_at`,
    })
    .returning({ id: infoItems.id });

  return inserted.length;
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ ok: false, reason: 'unauthorized' }, { status: 401 });

  try {
    // 오래 안 돈 소스부터. 크론이 하루 1회뿐이라 **한 회차에 최대한 많이** 돌되,
    // 서버리스 시간 제한에 걸리지 않게 **시간 예산**으로 끊는다.
    // 🔴 고정 개수로 끊으면 소스가 늘 때마다 순회 주기가 조용히 길어진다 —
    //    16개를 3개씩 돌면 한 바퀴에 엿새다. 그 사이 새 글은 안 보인다.
    const started = Date.now();
    const all = await db
      .select()
      .from(infoSources)
      .where(eq(infoSources.enabled, true))
      // ⚠ `asc()`로 감싸면 `... nulls first asc`가 되어 문법 오류다(admin/info와 같은 함정).
      .orderBy(sql`${infoSources.lastRunAt} asc nulls first`)
      .limit(MAX_SOURCES_PER_RUN);

    const due: typeof all = [];
    const results: PromiseSettledResult<number>[] = [];
    for (let i = 0; i < all.length; i += SOURCE_BATCH) {
      if (Date.now() - started > RUN_BUDGET_MS) break; // 예산 초과 — 나머지는 내일 먼저 돈다
      const batch = all.slice(i, i + SOURCE_BATCH);
      due.push(...batch);
      results.push(...(await Promise.allSettled(batch.map((s) => collect(s)))));
    }

    const now = new Date();

    const report: { id: string; ok: boolean; n?: number; error?: string }[] = [];
    for (let i = 0; i < due.length; i++) {
      const src = due[i];
      const r = results[i];
      if (r.status === 'fulfilled') {
        await db
          .update(infoSources)
          .set({ lastRunAt: now, lastOkAt: now, lastError: null, lastCount: r.value })
          .where(eq(infoSources.id, src.id));
        report.push({ id: src.id, ok: true, n: r.value });
      } else {
        // 🔴 `lastOkAt`은 **안 건드린다**. 그래야 "며칠째 못 가져오나"가 화면에서 읽힌다.
        const msg = redact(r.reason instanceof Error ? r.reason.message : String(r.reason));
        await db.update(infoSources).set({ lastRunAt: now, lastError: msg }).where(eq(infoSources.id, src.id));
        report.push({ id: src.id, ok: false, error: msg });
      }
    }

    return NextResponse.json({ ok: true, ran: due.length, of: all.length, ms: Date.now() - started, sources: report });
  } catch (e) {
    reportError(e, 'cron/info');
    return NextResponse.json({ ok: false, reason: 'error' }, { status: 500 });
  }
}
