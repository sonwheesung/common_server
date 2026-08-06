// GET /api/cron/purge — 보관기간 경과분 파기(일 1회, vercel.json crons).
//
// 인증: Vercel이 크론콜에 `Authorization: Bearer $CRON_SECRET`을 자동 첨부한다.
// **fail-closed** — 배포 환경에서 CRON_SECRET이 없으면 거부한다. 여기서 fail-open을 쓰면
// 아무나 파기를 트리거할 수 있게 된다(파기는 되돌릴 수 없는 작업이라 관리자 라우트보다 더 엄해야 한다).
import { NextResponse } from 'next/server';
import { and, isNotNull, lt } from 'drizzle-orm';
import { db } from '../../../../db';
import { announcements, tickets } from '../../../../db/schema';
import { ANNOUNCEMENT_PURGE_AFTER_END_DAYS, TICKET_RETENTION_DAYS, daysAgo } from '../../../../lib/retention';
import { reportError } from '../../../../lib/observability';

export const dynamic = 'force-dynamic';

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET ?? ''; // 호출 시점 읽기
  const isDeployed = process.env.VERCEL_ENV === 'production' || process.env.VERCEL_ENV === 'preview';
  if (!secret) return !isDeployed; // 배포에선 미설정=거부, 로컬은 허용(수동 검증)
  return req.headers.get('authorization') === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ ok: false, reason: 'unauthorized' }, { status: 401 });

  try {
    // 문의 — 보관기간 경과분 삭제. 본문에 사용자가 직접 쓴 내용이 들어가므로 기한이 지나면 지운다.
    const purgedTickets = await db
      .delete(tickets)
      .where(lt(tickets.createdAt, daysAgo(TICKET_RETENTION_DAYS)))
      .returning({ id: tickets.id });

    // 공지 — 종료 후 유예가 지난 것만. endsAt이 null(무기한)이면 대상 아님.
    const purgedAnns = await db
      .delete(announcements)
      .where(
        and(
          isNotNull(announcements.endsAt),
          lt(announcements.endsAt, daysAgo(ANNOUNCEMENT_PURGE_AFTER_END_DAYS)),
        ),
      )
      .returning({ id: announcements.id });

    return NextResponse.json({ ok: true, purged: { tickets: purgedTickets.length, announcements: purgedAnns.length } });
  } catch (e) {
    reportError(e, 'cron/purge');
    return NextResponse.json({ ok: false, reason: 'error' }, { status: 500 });
  }
}
