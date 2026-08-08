// POST /api/v1/tickets — 익명 문의 접수(로그인 없음 · 단방향).
//
// 무인증 공개 write라 방어를 두 겹으로 둔다:
//   1) IP 레이트리밋 — Upstash 미설정 시 fail-open(무력)이라 이것만으로는 부족
//   2) 앱별 24시간 총량 캡 — DB 카운트 기반이라 Upstash 없이도 동작(fail-closed). **실질 방어선**
//      캡의 역할은 가용성 보장이 아니라 **피해량 제한**이다(스크립트는 어떤 값이든 소진시킬 수 있으므로).
//
// 저장하는 기기정보는 platform·appVersion 뿐이다. osVersion·IP는 저장하지 않는다(개인정보 최소수집).
// IP는 레이트리밋 키로만 쓰고 버린다.
import { NextResponse } from 'next/server';
import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from '../../../../db';
import { tickets } from '../../../../db/schema';
import { getActiveApp } from '../../../../lib/apps';
import { requireSubject } from '../../../../lib/auth/subject';
import { checkLimit, clientIp } from '../../../../lib/ratelimit';
import { afterSafe } from '../../../../lib/afterSafe';
import { notifyTicket } from '../../../../lib/notify';
import { reportError } from '../../../../lib/observability';

export const dynamic = 'force-dynamic';

const CATEGORIES = new Set(['bug', 'suggestion', 'question', 'etc']);
const CONTENT_MIN = 5;
const CONTENT_MAX = 2000;

const clip = (v: unknown, max: number): string | null => (typeof v === 'string' && v ? v.slice(0, max) : null);

export async function POST(req: Request) {
  // 1차 방어: IP 레이트리밋. Upstash 미설정이면 통과(fail-open).
  if (!(await checkLimit('ticket', clientIp(req))).ok) {
    return NextResponse.json({ ok: false, reason: 'rate-limited' }, { status: 429 });
  }

  try {
    const b = (await req.json()) as {
      app?: string;
      category?: string;
      content?: string;
      device?: { platform?: string; appVersion?: string };
    };

    const app = await getActiveApp(b.app);
    if (!app) return NextResponse.json({ ok: false, reason: 'not-found' }, { status: 404 });

    // 로그인은 **선택**이다. 세션이 있으면 문의를 그 주체에 귀속시켜 답변을 돌려줄 수 있게 하고,
    // 없으면 기존처럼 익명으로 받는다(비회원 앱은 계속 이 경로로 온다).
    //
    // 단, Authorization 헤더가 **있는데 무효**면 익명으로 조용히 강등시키지 않고 401을 준다.
    // 강등시키면 로그인한 사용자의 문의가 귀속 없이 저장돼 답변을 영영 못 받는데,
    // 앱도 사용자도 그 사실을 알 방법이 없다 — 조용히 실패하는 쪽이 훨씬 나쁘다.
    let subjectId: string | null = null;
    if (req.headers.get('authorization')) {
      const authed = await requireSubject(req);
      if (!authed || authed.subject.appCode !== app.appCode) {
        return NextResponse.json({ ok: false, reason: 'unauthorized' }, { status: 401 });
      }
      subjectId = authed.subject.id;
    }

    const category = CATEGORIES.has(b.category ?? '') ? (b.category as string) : 'etc';
    const content = (b.content ?? '').trim();
    if (content.length < CONTENT_MIN) {
      return NextResponse.json({ ok: false, reason: 'bad-request' }, { status: 400 });
    }

    // 2차 방어: 앱별 24시간 총량 캡. 익명이라 사용자별 구분이 불가능해 앱 전체 합으로 센다.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const counted = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(tickets)
      .where(and(eq(tickets.appCode, app.appCode), gte(tickets.createdAt, since)));
    if ((counted[0]?.n ?? 0) >= app.ticketDailyCap) {
      return NextResponse.json({ ok: false, reason: 'rate-limited' }, { status: 429 });
    }

    const platform = clip(b.device?.platform, 32);
    const appVersion = clip(b.device?.appVersion, 32);

    const ins = await db
      .insert(tickets)
      .values({
        appCode: app.appCode,
        subjectId, // 익명이면 null — 기존 문의와 같은 모양으로 저장된다
        category,
        content: content.slice(0, CONTENT_MAX),
        platform,
        appVersion,
      })
      .returning({ id: tickets.id });

    // 디스코드 통지는 응답 후(afterSafe) — 서버리스 freeze 유실 방지. URL 미설정이면 no-op.
    afterSafe(() =>
      notifyTicket({
        ticketId: ins[0].id,
        appCode: app.appCode,
        appName: app.name,
        category,
        content,
        platform,
        appVersion,
      }),
    );

    // ticketId를 돌려주지 않는다 — 조회·답변 경로가 없어 클라가 쓸 데가 없다(불필요한 식별자 노출 회피).
    return NextResponse.json({ ok: true });
  } catch (e) {
    reportError(e, 'v1/tickets');
    return NextResponse.json({ ok: false, reason: 'error' }, { status: 500 });
  }
}
