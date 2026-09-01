// /api/admin/tickets?app=<appCode>&status=&category=&internal= — 문의 열람·처리.
//
// 익명 문의의 `reply`는 **관리자 내부 메모**다(사용자에게 돌려줄 경로가 없다). 회원 문의는 같은 컬럼이
// 앱의 "내 문의 내역"에 그대로 노출된다 — 콘솔이 그 차이를 표시해 운영자가 메모 쓰듯 답변하는 사고를 막는다.
import { NextResponse } from 'next/server';
import { and, count, desc, eq, like, not, sql, type SQL } from 'drizzle-orm';
import { db } from '../../../../db';
import { subjects, tickets } from '../../../../db/schema';
import { isAdmin } from '../../../../lib/admin';
import { normalizeAppCode } from '../../../../lib/apps';
import { reportError } from '../../../../lib/observability';

export const dynamic = 'force-dynamic';

// 상태 워크플로: open(대기) → reviewing(확인 중) → replied(답변함) / resolved(완료).
//
// **reviewing이 이 집합의 존재 이유다.** "읽었고 조사 중인데 아직 답을 못 쓴" 상태를 표현할 수 없으면,
// 운영자가 목록을 다시 열 때마다 어디까지 봤는지 처음부터 다시 읽는다.
//
// ⚠ replied/resolved는 **이름을 바꾸지 않는다**. `v1/tickets/mine`이 이 값을 앱에 그대로 내려주므로
//   배구처럼 answered로 개명하면 이미 나간 앱의 분기가 깨진다. 추가는 하되 개명은 안 한다(Expand-only).
const STATUSES = new Set(['open', 'reviewing', 'replied', 'resolved']);
const CATEGORIES = new Set(['bug', 'suggestion', 'question', 'etc']);
const LIST_LIMIT = 200;

// 로컬 dev가 프로덕션 DB를 쓰기 때문에(CLAUDE.md) 가드가 만든 문의가 운영 문의와 같은 테이블에 쌓인다.
// `tools/_dv_public.ts`가 본문 앞에 박는 이 접두사가 유일한 표식이다.
// LIKE에서 `_`는 와일드카드라 이스케이프한다(Postgres 기본 escape = 백슬래시).
const DEV_PREFIX_LIKE = '[\_dv\_public]%';
const notDev = not(like(tickets.content, DEV_PREFIX_LIKE));

const deny = () => NextResponse.json({ ok: false, reason: 'unauthorized' }, { status: 401 });
const bad = (reason = 'bad-request') => NextResponse.json({ ok: false, reason }, { status: 400 });

export async function GET(req: Request) {
  if (!isAdmin(req)) return deny();
  try {
    const q = new URL(req.url).searchParams;
    const appCode = normalizeAppCode(q.get('app'));
    if (!appCode) return bad();

    const status = q.get('status');
    const category = q.get('category');
    // 기본은 hide — 목록의 기본 질문은 "실사용자 문의가 어떤가"다. 가드 문의는 볼 때만 켠다.
    const showDev = q.get('internal') === 'show';

    const conds: SQL[] = [eq(tickets.appCode, appCode)];
    if (status && STATUSES.has(status)) conds.push(eq(tickets.status, status));
    if (category && CATEGORIES.has(category)) conds.push(eq(tickets.category, category));
    if (!showDev) conds.push(notDev);

    // 작성자 이메일을 함께 준다 — 로그인 문의는 "누구의 문의인지" 알아야 답변을 쓸 수 있다.
    // LEFT JOIN이라 익명 문의(subject_id null)는 그대로 나오고 이메일만 null이다.
    const [rows, dev] = await Promise.all([
      db
        .select({
          id: tickets.id,
          subjectId: tickets.subjectId,
          subjectEmail: subjects.email,
          subjectDeleted: subjects.deletedAt,
          category: tickets.category,
          content: tickets.content,
          status: tickets.status,
          reply: tickets.reply,
          repliedAt: tickets.repliedAt,
          platform: tickets.platform,
          appVersion: tickets.appVersion,
          createdAt: tickets.createdAt,
        })
        .from(tickets)
        .leftJoin(subjects, eq(tickets.subjectId, subjects.id))
        .where(and(...conds))
        .orderBy(desc(tickets.createdAt))
        .limit(LIST_LIMIT),
      // 가린 건수를 **함께 준다**. 숨기고 말이 없으면 숫자가 조용히 달라져 판독을 그르친다 — 가렸다고 말한다.
      db
        .select({ n: count() })
        .from(tickets)
        .where(and(eq(tickets.appCode, appCode), like(tickets.content, DEV_PREFIX_LIKE))),
    ]);

    return NextResponse.json({ ok: true, tickets: rows, devCount: dev[0]?.n ?? 0, devShown: showDev });
  } catch (e) {
    reportError(e, 'admin/tickets:GET');
    return NextResponse.json({ ok: false, reason: 'error' }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  if (!isAdmin(req)) return deny();
  try {
    const b = (await req.json()) as { id?: string; app?: string; status?: string; reply?: string };
    const id = String(b.id ?? '');
    const appCode = normalizeAppCode(b.app);
    // 앱 스코프는 **필수**다. 여긴 1배포 N앱이라 id만으로 UPDATE하면 콘솔이 A앱을 보는 중에
    // B앱 티켓 id로 답변이 박혀도 조용히 성공한다(GET은 앱으로 거르는데 PATCH만 안 거르는 비대칭이었다).
    if (!id || !appCode) return bad();

    const patch: Record<string, unknown> = {};
    if (typeof b.status === 'string' && STATUSES.has(b.status)) patch.status = b.status;
    if (typeof b.reply === 'string') {
      patch.reply = b.reply.trim().slice(0, 4000) || null;
      patch.repliedAt = patch.reply ? sql`now()` : null;
      // 상태를 **명시하지 않은 호출에 한해서만** 폴백한다. 콘솔은 항상 명시로 보내므로
      // 여기 폴백이 운영자의 선택을 덮지 않는다(상태는 입력의 부산물이 아니라 운영자가 정하는 값이다).
      if (!patch.status && patch.reply) patch.status = 'replied';
    }
    if (!Object.keys(patch).length) return bad('nothing-to-update');

    const updated = await db
      .update(tickets)
      .set(patch)
      .where(and(eq(tickets.appCode, appCode), eq(tickets.id, id)))
      .returning();
    if (!updated.length) return NextResponse.json({ ok: false, reason: 'not-found' }, { status: 404 });
    return NextResponse.json({ ok: true, ticket: updated[0] });
  } catch (e) {
    reportError(e, 'admin/tickets:PATCH');
    return NextResponse.json({ ok: false, reason: 'error' }, { status: 500 });
  }
}
