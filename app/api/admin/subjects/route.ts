// /api/admin/subjects?app=<appCode>&status=&sort=&limit=&offset= — 사용자(주체) 목록.
//
// 회원 문의가 들어와도 "이 사람이 누구이고, 언제 가입했고, 구독이 살아 있는지"를 볼 화면이 없었다.
// 콘솔에서 문의 → 사용자로 이어지는 최소 경로를 만든다.
//
// ⚠ 개인정보(이메일)를 다루는 목록이다. 관리자 전용(fail-closed) + 페이지당 상한을 둔다.
//   provider_id 원문은 **내려주지 않는다** — 운영 판독에 쓸 일이 없고, 유출 시 계정 특정에 쓰인다.
import { NextResponse } from 'next/server';
import { and, count, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../../../db';
import { entitlements, subjects, tickets } from '../../../../db/schema';
import { isAdmin } from '../../../../lib/admin';
import { normalizeAppCode } from '../../../../lib/apps';
import { viewOf } from '../../../../lib/revenuecat';
import { reportError } from '../../../../lib/observability';

export const dynamic = 'force-dynamic';

/** 활성 기준 — 마지막 접속 14일 이내. 콘솔의 '활성' 배지와 같은 임계다(두 곳이 어긋나면 판독을 그르친다). */
export const ACTIVE_DAYS = 14;
const MAX_LIMIT = 100;

const deny = () => NextResponse.json({ ok: false, reason: 'unauthorized' }, { status: 401 });
const bad = (reason = 'bad-request') => NextResponse.json({ ok: false, reason }, { status: 400 });

const num = (raw: string | null, def: number, max: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), max) : def;
};

export async function GET(req: Request) {
  if (!isAdmin(req)) return deny();
  try {
    const q = new URL(req.url).searchParams;
    const appCode = normalizeAppCode(q.get('app'));
    if (!appCode) return bad();

    const status = q.get('status') ?? 'all';
    // 정렬 축 — created(가입일) | seen(최근 접속). 둘 다 최신순.
    //   묻는 질문이 다르다: created는 "누가 새로 왔나", seen은 "누가 지금 쓰고 있나".
    //   ⚠ seen은 lastSeenAt이 null인 사람(한 번도 하트비트가 안 붙은 구버전 사용자)을
    //   맨 뒤로 보낸다 — nulls last. 앞으로 오면 "가장 오래된 사람"으로 오독된다.
    const sort = q.get('sort') === 'seen' ? 'seen' : 'created';
    const orderBy =
      sort === 'seen' ? sql`${subjects.lastSeenAt} desc nulls last` : desc(subjects.createdAt);
    const limit = num(q.get('limit'), 50, MAX_LIMIT) || 50;
    const offset = num(q.get('offset'), 0, 100_000);

    const cutoff = new Date(Date.now() - ACTIVE_DAYS * 86400_000);
    const alive = isNull(subjects.deletedAt);
    const conds: SQL[] = [eq(subjects.appCode, appCode)];
    if (status === 'active') conds.push(alive, gte(subjects.lastSeenAt, cutoff));
    else if (status === 'inactive')
      conds.push(alive, or(isNull(subjects.lastSeenAt), lt(subjects.lastSeenAt, cutoff))!);
    else if (status === 'withdrawn') conds.push(isNotNull(subjects.deletedAt));
    const where = and(...conds);

    // 총 건수는 **현재 필터 기준**이다 — 화면의 행 수와 페이저의 분모가 같은 축을 봐야 한다.
    const [rows, totalRow] = await Promise.all([
      db
        .select({
          id: subjects.id,
          kind: subjects.kind,
          provider: subjects.provider,
          email: subjects.email,
          createdAt: subjects.createdAt,
          lastSeenAt: subjects.lastSeenAt,
          deletedAt: subjects.deletedAt,
        })
        .from(subjects)
        .where(where)
        .orderBy(orderBy)
        .limit(limit)
        .offset(offset),
      db.select({ n: count() }).from(subjects).where(where),
    ]);

    // 문의 수·엔타이틀먼트는 **이 페이지의 행에 대해서만** 따로 조회한다.
    // 조인+groupBy로 한 번에 하면 목록 쿼리가 집계에 묶여 페이지네이션이 흔들린다.
    const ids = rows.map((r) => r.id);
    const [tks, ents] = ids.length
      ? await Promise.all([
          db
            .select({ subjectId: tickets.subjectId, n: count() })
            .from(tickets)
            .where(inArray(tickets.subjectId, ids))
            .groupBy(tickets.subjectId),
          db
            .select({
              subjectId: entitlements.subjectId,
              key: entitlements.key,
              expiresAt: entitlements.expiresAt,
              graceUntil: entitlements.graceUntil,
              willRenew: entitlements.willRenew,
              lastTxnId: entitlements.lastTxnId,
              revokedTxnId: entitlements.revokedTxnId,
            })
            .from(entitlements)
            .where(inArray(entitlements.subjectId, ids)),
        ])
      : [[], []];

    const ticketCount = new Map(tks.map((t) => [t.subjectId, t.n]));
    const now = new Date();
    // active 여부는 저장값이 아니라 **계산값**이다(schema 주석) — 여기서도 같은 viewOf를 쓴다.
    const entOf = new Map<string, { key: string; active: boolean; expiresAt: string | null }>();
    for (const e of ents) {
      const v = viewOf(e, now);
      const prev = entOf.get(e.subjectId);
      // 키가 여럿이면 활성인 쪽을 대표로 — 목록에서 알고 싶은 건 "지금 권한이 있나"다.
      if (!prev || (v.active && !prev.active))
        entOf.set(e.subjectId, { key: e.key, active: v.active, expiresAt: v.expiresAt });
    }

    return NextResponse.json({
      ok: true,
      total: totalRow[0]?.n ?? 0,
      activeDays: ACTIVE_DAYS,
      sort,
      subjects: rows.map((r) => ({
        ...r,
        ticketCount: ticketCount.get(r.id) ?? 0,
        entitlement: entOf.get(r.id) ?? null,
      })),
    });
  } catch (e) {
    reportError(e, 'admin/subjects:GET');
    return NextResponse.json({ ok: false, reason: 'error' }, { status: 500 });
  }
}
