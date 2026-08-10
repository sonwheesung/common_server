// POST /api/webhooks/revenuecat/<app_code> — RevenueCat 웹훅 수신.
//
// **`/api/v1/` 밖에 둔다.** 저긴 앱이 부르는 공개 계약면이고 CORS 헤더가 붙는다(next.config.mjs).
// 이건 서버간 통신이라 성격이 다르다.
//
// ⚠ 상태 코드는 로그 레벨이 아니라 **재시도 지시**다. RC는 비-2xx를 백오프로 재전송한다.
//   영원히 실패할 조건(탈퇴한 주체·미등록 앱·모르는 키)에 5xx를 주면 같은 이벤트가 에러 지표를 채운다.
//   → 되돌릴 수 없는 조건은 200 + 감사행, 재시도로 나아질 수 있는 것(DB 장애)만 5xx.
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '../../../../../db';
import { apps } from '../../../../../db/schema';
import { normalizeAppCode } from '../../../../../lib/apps';
import { applyEvent } from '../../../../../lib/entitlement';
import { decideEvent, verifyWebhookAuth, type RcEvent } from '../../../../../lib/revenuecat';
import { reportError } from '../../../../../lib/observability';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ app: string }> }) {
  try {
    const appCode = normalizeAppCode((await ctx.params).app);
    if (!appCode) return NextResponse.json({ ok: false, reason: 'not-found' }, { status: 404 });

    // 비활성 앱도 웹훅은 받는다 — 앱을 잠시 끈 사이의 환불을 놓치면 되돌릴 방법이 없다.
    const app = (await db.select().from(apps).where(eq(apps.appCode, appCode)).limit(1))[0];
    if (!app) return NextResponse.json({ ok: false, reason: 'not-found' }, { status: 404 });

    // 시크릿 해시가 없으면 그 앱 웹훅은 전면 거부(fail-closed). 없으면 아무나 구독자를 만들 수 있다.
    if (!verifyWebhookAuth(req, app.rcWebhookSecretHash)) {
      return NextResponse.json({ ok: false, reason: 'unauthorized' }, { status: 401 });
    }

    const body = (await req.json()) as { event?: RcEvent } & RcEvent;
    // RC는 { event: {...} }로 감싸 보낸다. 평평한 형태도 받아둔다(테스트 도구·버전 차이).
    const event: RcEvent = body.event ?? body;

    const allowed = app.entitlementKeys.split(',');
    const decision = decideEvent(event, allowed);
    const result = await applyEvent(appCode, event, decision);

    // 전부 200이다. 어떻게 처리됐는지는 body와 감사행(purchase_events)에 남는다.
    return NextResponse.json({ ok: true, outcome: result.status, reason: 'reason' in result ? result.reason : undefined });
  } catch (e) {
    // 여기까지 온 건 파싱 실패나 DB 장애 — 재시도로 나아질 수 있으므로 5xx가 맞다.
    reportError(e, 'webhooks/revenuecat');
    return NextResponse.json({ ok: false, reason: 'error' }, { status: 500 });
  }
}
