// 정보 허브 관리자 라우트 — 목록 · 수집 상태 · 읽음 표시 · 소스 켜고 끄기.
// 설계는 `docs/INFO_HUB.md`.
//
// 🔴 **이 라우트에는 앱 스코프(`?app=`)가 없다 — 이 저장소의 유일한 예외다.**
//    `CLAUDE.md` 규약("관리자 write는 앱 스코프 필수")의 목적은 **앱 사이 오염 방지**인데,
//    이 데이터에는 앱이 없어 오염될 남의 앱이 없다(§1-1). 그래서 규약이 성립하지 않는다.
//    ⚠ 대신 **`app` 파라미터를 줘도 결과가 안 바뀐다** — 조용히 필터되면 운영자가
//    "이 앱 관련 공고"로 오독한다. 화면도 "앱과 무관"을 명시한다. 가드가 이걸 검사한다.
import { NextResponse } from 'next/server';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../../../db';
import { infoItems, infoSources } from '../../../../db/schema';
import { isAdmin } from '../../../../lib/admin';
import { reportError } from '../../../../lib/observability';

export const dynamic = 'force-dynamic';

const KINDS = new Set(['grant', 'community']);
/** 기본으로 보여줄 기간(일). 좁게 잡는다 — 넓히는 건 클릭 한 번이지만, 안 읽히면 기능 전체가 죽는다. */
const DEFAULT_DAYS = 3;
const LIST_LIMIT = 200;

const deny = () => NextResponse.json({ ok: false, reason: 'unauthorized' }, { status: 401 });
const bad = (reason = 'bad-request') => NextResponse.json({ ok: false, reason }, { status: 400 });

export async function GET(req: Request) {
  if (!isAdmin(req)) return deny();
  try {
    const q = new URL(req.url).searchParams;
    const kind = q.get('kind') ?? 'grant';
    if (!KINDS.has(kind)) return bad();
    const showExpired = q.get('expired') === 'show';
    const unreadOnly = q.get('unread') === 'only';

    const conds = [eq(infoItems.kind, kind)];
    // 마감이 지난 것은 기본으로 숨긴다. 🔴 마감이 **null**(상시·예산소진시)인 것은 숨기지 않는다 —
    // "마감 없음"이 아니라 "마감을 모름"이라 지난 것으로 칠 수 없다(lib/info.ts parsePeriod 주석).
    if (!showExpired) conds.push(sql`(${infoItems.endsAt} is null or ${infoItems.endsAt} >= now())`);
    if (unreadOnly) conds.push(isNull(infoItems.readAt));
    // 카테고리 필터. 값을 화이트리스트로 막지 않는다 — 분류는 `info_sources.config`에서 오고,
    // 소스를 늘리는 데 재배포가 필요 없어야 한다(§3-3). 없는 값이면 그냥 0건이 나온다.
    const category = q.get('category');
    if (category) conds.push(eq(infoItems.category, category));

    // 🔴 **기간 창** — 이 기능이 실패하는 첫째 방식은 "너무 많아서 안 읽는 것"이다(§0).
    //    첫 수집이 피드의 **과거 아카이브를 통째로** 가져오므로(Replicate 2023년치까지) 기본을 좁게 잡는다.
    //    ⚠ 지우지 않는다 — 지워도 아직 피드에 실려 있으면 **다음 수집에 그대로 다시 들어온다.**
    //    보관은 파기 규칙(90일)이 하고, 읽기는 이 창이 한다. 둘은 다른 일이다.
    const days = Number(q.get('days') ?? DEFAULT_DAYS);
    if (Number.isFinite(days) && days > 0) {
      // 게시일을 모르는 항목(피드가 날짜를 안 주는 경우)은 **버리지 않고** 수집일로 대신 본다.
      // 날짜가 없다고 오래된 글은 아니다 — 모르는 것을 오래된 것으로 취급하면 조용히 사라진다.
      conds.push(sql`coalesce(${infoItems.publishedAt}, ${infoItems.fetchedAt}) >= now() - (${days} || ' days')::interval`);
    }

    // 제목·요약 검색. 관심사가 분명한 사람에게는 이게 카테고리보다 강한 필터다.
    const term = (q.get('q') ?? '').trim();
    if (term) {
      const like = `%${term.replace(/[%_]/g, (m) => `\${m}`)}%`;
      conds.push(sql`(${infoItems.title} ilike ${like} or coalesce(${infoItems.summary},'') ilike ${like})`);
    }

    const [items, sources, categories, expiredCount] = await Promise.all([
      db
        .select()
        .from(infoItems)
        .where(and(...conds))
        // 지원사업은 **마감 임박순**이 기본이다 — 놓쳐서 아픈 건 등록일이 아니라 마감이다.
        // 마감을 모르는 항목(null)은 맨 뒤로 보낸다(급하지 않다는 뜻이 아니라 정렬할 수 없다는 뜻).
        // ⚠ `asc()`로 감싸면 `... nulls last asc`가 되어 문법 오류다. 정렬 방향을 raw 안에 함께 쓴다.
        .orderBy(
          kind === 'grant'
            ? sql`${infoItems.endsAt} asc nulls last`
            : sql`${infoItems.publishedAt} desc nulls last`,
        )
        .limit(LIST_LIMIT + 1), // +1 — 상한에 걸렸는지 알기 위해 한 건 더 받아본다
      db.select().from(infoSources).where(eq(infoSources.kind, kind)).orderBy(asc(infoSources.id)),
      // 카테고리별 건수 — 화면의 필터 칩에 숫자를 같이 띄운다.
      // 🔴 목록과 **같은 마감/읽음 조건**을 쓰지 않는다는 점을 분명히 해둔다: 이건 "그 분류에 몇 건이 있나"이지
      //    "지금 화면에 몇 건 뜨나"가 아니다. 두 수를 같은 뜻으로 읽으면 안 된다.
      db
        .select({ category: infoItems.category, n: sql<number>`count(*)::int` })
        .from(infoItems)
        // 🔴 칩 숫자는 **목록과 같은 기간 창**을 써야 한다. 안 그러면 "AI 429" 를 눌렀는데 12건이 뜬다 —
        //    두 곳이 같은 사실을 다르게 세는 그 함정이다(docs/NEXT.md §1-4).
        .where(
          and(
            eq(infoItems.kind, kind),
            sql`(${infoItems.endsAt} is null or ${infoItems.endsAt} >= now())`,
            Number.isFinite(days) && days > 0
              ? sql`coalesce(${infoItems.publishedAt}, ${infoItems.fetchedAt}) >= now() - (${days} || ' days')::interval`
              : sql`true`,
          ),
        )
        .groupBy(infoItems.category),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(infoItems)
        .where(and(eq(infoItems.kind, kind), sql`${infoItems.endsAt} < now()`)),
    ]);

    // 🔴 잘렸으면 **잘렸다고 말한다.** 200건만 보여주고 입을 다물면 화면이
    //    "이게 전부"라고 거짓말한다 — 이 저장소가 반복해서 막아 온 그 형태다.
    const capped = items.length > LIST_LIMIT;
    if (capped) items.length = LIST_LIMIT;

    return NextResponse.json({
      ok: true,
      capped,
      limit: LIST_LIMIT,
      // 🔴 화면이 "앱과 무관"을 말할 수 있게 서버가 먼저 선언한다. 화면에만 적으면 어긋난다.
      appScoped: false,
      kind,
      days,
      items,
      // 수집 상태 — **이게 화면의 절반이다**(§6-2). 빈 목록이 "새 공고 없음"인지 "수집이 죽었음"인지
      // 여기서만 갈린다. lastRunAt/lastOkAt을 둘 다 내려보내는 이유가 그것이다.
      sources,
      categories,
      expiredCount: expiredCount[0]?.n ?? 0,
    });
  } catch (e) {
    reportError(e, 'admin/info');
    return NextResponse.json({ ok: false, reason: 'error' }, { status: 500 });
  }
}

/** 읽음 표시 토글 · 소스 켜고 끄기. 둘 다 **운영자가 정하는 상태**라 수집의 부수효과로 바뀌지 않는다. */
export async function PATCH(req: Request) {
  if (!isAdmin(req)) return deny();
  try {
    const body = (await req.json().catch(() => null)) as
      | { itemId?: string; read?: boolean; sourceId?: string; enabled?: boolean }
      | null;
    if (!body) return bad();

    if (body.itemId) {
      const r = await db
        .update(infoItems)
        .set({ readAt: body.read === false ? null : new Date() })
        .where(eq(infoItems.id, body.itemId))
        .returning({ id: infoItems.id });
      return r.length ? NextResponse.json({ ok: true }) : NextResponse.json({ ok: false, reason: 'not-found' }, { status: 404 });
    }

    if (body.sourceId && typeof body.enabled === 'boolean') {
      const r = await db
        .update(infoSources)
        .set({ enabled: body.enabled })
        .where(eq(infoSources.id, body.sourceId))
        .returning({ id: infoSources.id });
      return r.length ? NextResponse.json({ ok: true }) : NextResponse.json({ ok: false, reason: 'not-found' }, { status: 404 });
    }

    return bad('nothing-to-update');
  } catch (e) {
    reportError(e, 'admin/info');
    return NextResponse.json({ ok: false, reason: 'error' }, { status: 500 });
  }
}
