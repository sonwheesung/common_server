// GET /api/v1/entitlements — 내 엔타이틀먼트(구독). Bearer 세션 토큰.
//
// 구독자가 아니어도 200이다 — 없으면 `{}`. 404를 주면 앱이 "서버 오류"와 "미구독"을 구분하지 못하고,
// 그 차이는 **광고를 띄울지 말지**를 가른다.
//
// `checkedAt`을 함께 준다: 앱이 오프라인에서 광고를 안 띄우려면 캐시해야 하는데,
// 기기 시계가 틀어져 있으면 만료 판단이 어긋난다. 서버 시각을 같이 받으면 보정할 수 있다.
//
// ── pull 폴백 ──
// **활성 엔타이틀먼트가 하나도 없을 때만** RC에 직접 물어본다(lib/rcPull.ts).
// 웹훅은 5회 재시도 후 포기하므로, 이 자리가 없으면 유실된 사용자는 영구히 pro가 아니다.
// 부정 답을 주기 직전에만 걸리므로 구독자에겐 비용이 0이고, 미구독자는 쿨다운(기본 6시간)이 막는다.
//
// `?fresh=1`은 구매 직후·복원 버튼용 짧은 쿨다운(60초)이다. **모르는 파라미터는 무시된다** —
// 서버와 SDK 배포 순서에 자유를 주기 위해서(구버전 SDK가 붙여도, 구버전 서버가 받아도 깨지지 않는다).
import { NextResponse } from 'next/server';
import { requireSubject } from '../../../../lib/auth/subject';
import { entitlementsOf, pullEntitlements } from '../../../../lib/entitlement';
import { pullCooldownFor } from '../../../../lib/rcPull';
import { reportError } from '../../../../lib/observability';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const authed = await requireSubject(req);
    if (!authed) return NextResponse.json({ ok: false, reason: 'unauthorized' }, { status: 401 });

    let entitlements = await entitlementsOf(authed.subject.id);

    const views = Object.values(entitlements);
    if (!views.some((e) => e.active)) {
      const fresh = new URL(req.url).searchParams.get('fresh') === '1';
      // 쿨다운은 "우리가 얼마나 틀렸을 수 있나"에 맞춘다 — 갱신 예정인데 만료돼 있으면 10분,
      // 그 외엔 6시간(`pullCooldownFor`). 하나로 두면 결제한 사람이 6시간 잠기는 창이 생긴다.
      const cooldownSec = pullCooldownFor(views, new Date());
      // RC 장애는 여기서 삼킨다. 500을 주면 앱은 unreachable로 보고 캐시를 유지하는데,
      // 500이 잦으면 관측이 오염된다 — **pull 실패 = 기존 DB 상태 그대로 200.**
      const pulled = await pullEntitlements(authed.subject.appCode, authed.subject.id, { fresh, cooldownSec });
      if (pulled.changed) entitlements = await entitlementsOf(authed.subject.id);
    }

    return NextResponse.json({ ok: true, entitlements, checkedAt: new Date().toISOString() });
  } catch (e) {
    reportError(e, 'v1/entitlements');
    return NextResponse.json({ ok: false, reason: 'error' }, { status: 500 });
  }
}
