// GET /api/cron/purge — 보관기간 경과분 파기(일 1회, vercel.json crons).
//
// 인증: Vercel이 크론콜에 `Authorization: Bearer $CRON_SECRET`을 자동 첨부한다.
// **fail-closed** — 배포 환경에서 CRON_SECRET이 없으면 거부한다. 여기서 fail-open을 쓰면
// 아무나 파기를 트리거할 수 있게 된다(파기는 되돌릴 수 없는 작업이라 관리자 라우트보다 더 엄해야 한다).
import { NextResponse } from 'next/server';
import { and, isNotNull, isNull, lt, or } from 'drizzle-orm';
import { db } from '../../../../db';
import { announcements, infoItems, tickets } from '../../../../db/schema';
import {
  ANNOUNCEMENT_PURGE_AFTER_END_DAYS,
  INFO_GRANT_PURGE_AFTER_END_DAYS,
  INFO_ITEM_RETENTION_DAYS,
  TICKET_RETENTION_DAYS,
  daysAgo,
} from '../../../../lib/retention';
import { purgeActiveDays } from '../../../../lib/activity';
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

    // 활성 일자 — 경과 기준 delete만. 주체 id + 날짜뿐이라 엇은 정보지만 목적이 끝나면 지운다는 원칙은 같다.
    const purgedDays = await purgeActiveDays();

    // 정보 허브(docs/INFO_HUB.md §5-3) — 파기 크론을 새로 만들지 않고 여기에 얹는다.
    // 규칙이 둘인 이유: 마감이 있는 항목은 **마감 기준**으로, 마감을 모르는 항목(상시·예산소진시)과
    // 커뮤니티 글은 **수집일 기준**으로 지운다. 마감 null을 "마감 없음"으로 보고 영구 보관하면 표가 계속 큰다.
    const purgedInfo = await db
      .delete(infoItems)
      .where(
        or(
          and(isNotNull(infoItems.endsAt), lt(infoItems.endsAt, daysAgo(INFO_GRANT_PURGE_AFTER_END_DAYS))),
          and(isNull(infoItems.endsAt), lt(infoItems.fetchedAt, daysAgo(INFO_ITEM_RETENTION_DAYS))),
        ),
      )
      .returning({ id: infoItems.id });

    return NextResponse.json({
      ok: true,
      purged: {
        tickets: purgedTickets.length,
        announcements: purgedAnns.length,
        activeDays: purgedDays,
        infoItems: purgedInfo.length,
      },
    });
  } catch (e) {
    reportError(e, 'cron/purge');
    return NextResponse.json({ ok: false, reason: 'error' }, { status: 500 });
  }
}
