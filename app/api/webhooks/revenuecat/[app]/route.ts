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
import { applyEvent, pullEntitlements } from '../../../../../lib/entitlement';
import { decideEvent, verifyWebhookAuth, type RcEvent } from '../../../../../lib/revenuecat';
import { afterSafe } from '../../../../../lib/afterSafe';
import { notifySubscription, shouldNotifySubscription } from '../../../../../lib/notify';
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

    // RC 공식 권고 — 웹훅을 받으면 GET /subscribers로 다시 당겨 동기화한다.
    // 페이로드가 부분적이거나 이 이벤트 전에 놓친 것이 있어도 여기서 메워진다.
    // 특히 **유실된 EXPIRATION**("해지했는데 영원히 pro")은 읽기 경로가 못 잡는다 —
    // 그쪽은 활성일 때 pull하지 않기 때문이다. 이 자리가 그걸 담당한다.
    //
    // afterSafe로 미룬다: RC는 응답이 늦으면 재전송한다. 동기화 실패로 이미 성공한 적용을 되돌릴 이유가 없다.
    if (decision.subjectId) {
      const subjectId = decision.subjectId;
      afterSafe(async () => {
        await pullEntitlements(appCode, subjectId, { fresh: true }); // 짧은 쿨다운 — 아니면 웹훅마다 걸러진다
      });
    }

    // 디스코드 통지 — 구독 시작·해지 예약·구독 종료 셋만(2026-09-09 사용자 결정).
    // 🔴 **`applied`일 때만 보낸다.** 이 조건이 알림의 전부다:
    //   · `deduped`  — RC는 응답이 늦으면 같은 이벤트를 재전송한다. 걸러야 알림이 두 번 안 온다.
    //   · `ignored`  — 샌드박스 테스트·모르는 키. 결제 테스트를 돌릴 때마다 채널이 시끄러워진다.
    //   · `rejected` — 미해석 주체. 알려봐야 사장님이 할 수 있는 게 없다.
    //   즉 **DB에 실제로 반영된 변화만** 알린다 — 화면(관리자 콘솔)과 알림이 어긋나지 않는다.
    if (result.status === 'applied' && shouldNotifySubscription(event.type ?? '')) {
      afterSafe(() =>
        notifySubscription({
          type: event.type ?? '',
          appCode,
          appName: app.name,
          productId: decision.productId ?? event.product_id ?? null,
          entitlementKey: decision.key ?? null,
          periodType: event.period_type ?? null,
          price: event.price ?? null,
          currency: event.currency ?? null,
          // 🔴 만료시각은 **판정 결과 → 원문** 순으로 본다. 판정만 보면 해지 알림의 핵심 숫자가 빈다:
          //   `CANCELLATION`·`REFUND`는 만료를 **안 건드리는** 이벤트라(mode:'none') decision에 expiresAt이 없다.
          //   그런데 원문에는 실려 온다(2026-08-20 실측: decision=null · 원문=2026-08-20T10:13:40).
          //   → 이건 **표시 전용 폴백**이다. 판정·DB 기록은 그대로 decision을 쓴다(둘을 섞으면 안 된다).
          expiresAt:
            decision.graceUntil ??
            decision.expiresAt ??
            (typeof event.expiration_at_ms === 'number' && event.expiration_at_ms > 0
              ? new Date(event.expiration_at_ms)
              : null),
          cancelReason: event.cancel_reason ?? null,
          environment: decision.environment ?? event.environment ?? null,
        }),
      );
    }

    // 전부 200이다. 어떻게 처리됐는지는 body와 감사행(purchase_events)에 남는다.
    return NextResponse.json({ ok: true, outcome: result.status, reason: 'reason' in result ? result.reason : undefined });
  } catch (e) {
    // 여기까지 온 건 파싱 실패나 DB 장애 — 재시도로 나아질 수 있으므로 5xx가 맞다.
    reportError(e, 'webhooks/revenuecat');
    return NextResponse.json({ ok: false, reason: 'error' }, { status: 500 });
  }
}
