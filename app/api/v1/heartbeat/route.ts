// POST /api/v1/heartbeat — 앱이 **포그라운드로 돌아올 때마다** 찍는 활성 신호. 2026-09-02 (Phase 13).
//
// **왜 별도 라우트인가**: 종전 하트비트는 `bootstrap`에 얹혀 있었고, 앱들은 그걸 JS 프로세스당
// 1회만 부른다. RN에서 홈 버튼은 프로세스를 죽이지 않으므로 **웜 스타트에는 신호가 한 번도 안 나갔다** —
// 앱을 안 죽이는 사용자일수록 DAU에서 덜 잡히는, 방향이 거꾸로인 오차였다.
// `bootstrap`을 다시 부르는 방식은 쓰지 않는다: 공지 50건 페이로드를 복귀마다 낚고,
// 진입 게이트 판정이 다시 돌아 점검 배너가 복귀할 때마다 다시 뜬다.
//
// ⚠ **`?app=`을 받지 않는다.** `bootstrap`은 공개 라우트라 쿼리로 앱을 받지만 여긴 **인증 라우트**다
//   (auth/me·tickets/mine·entitlements와 같은 부류). 토큰에 서명된 `app`이 이미 진실이므로
//   파라미터를 더하면 어긋날 수 있는 자리를 만드는 것뿐이고, 덤으로 앱 존재를 탐지할 면적도 생긴다.
//
// ⚠ **401이다 — bootstrap과 반대다.** bootstrap은 무효 토큰을 조용히 무시하고 200을 준다(진입
//   게이트라 세션 만료가 점검·강제업데이트 판정을 막으면 안 되기 때문). 여긴 감시할 게이트가 없고
//   관측이 유일한 임무라, 토큰이 죽었으면 그걸 앱이 알아야 다음 부팅에 재등록한다(자가 치유).
//   SDK가 401을 받으면 세션을 폐기하고, 그래도 **사용자에게는 아무것도 안 보인다**.
import { NextResponse } from 'next/server';
import { requireSubject } from '../../../../lib/auth/subject';
import { shouldRenew, signSession } from '../../../../lib/auth/session';
import { recordActive } from '../../../../lib/activity';
import { afterSafe } from '../../../../lib/afterSafe';
import { checkLimit, clientIp } from '../../../../lib/ratelimit';
import { reportError } from '../../../../lib/observability';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (!(await checkLimit('heartbeat', clientIp(req))).ok) {
    return NextResponse.json({ ok: false, reason: 'rate-limited' }, { status: 429 });
  }

  try {
    // 토큰·주체의 app을 대조하고 탈퇴자를 걸러낸다. 여기서 이미 주체를 읽어오므로
    // 아래 갱신의 **생존 확인이 공짜다**(bootstrap은 그걸 위해 쿼리를 하나 더 한다).
    const authed = await requireSubject(req);
    if (!authed) return NextResponse.json({ ok: false, reason: 'unauthorized' }, { status: 401 });
    const { subject, session: claims } = authed;

    // 응답 후 처리 — 관측이 복귀를 1ms도 늦추지 않는다. (app, subject, day) PK가 멱등이라
    // 5분에 한 번씩 찍혀도 하루 1행이고, `hours` 비트는 OR이라 순서와 무관하다.
    afterSafe(() => recordActive(subject.appCode, subject.id));

    // ── 슬라이딩 갱신 ──
    // bootstrap에만 두면 **앱을 안 죽이는 사용자는 갱신도 못 받는다** — 웜 스타트 구멍이
    // DAU와 토큰 수명 둘을 동시에 갉고 있었다. 여기가 그 둘을 같이 막는 자리다.
    // 재발급은 서명이라 DB를 안 건드리고, shouldRenew가 30일에 한 번만 참이라 사실상 공짜다.
    let session: { token: string } | undefined;
    if (shouldRenew(claims.iat)) {
      const next = signSession({ sid: subject.id, app: subject.appCode });
      if (next) session = { token: next };
    }

    return NextResponse.json({ ok: true, ...(session ? { session } : {}) });
  } catch (e) {
    reportError(e, 'v1/heartbeat');
    return NextResponse.json({ ok: false, reason: 'error' }, { status: 500 });
  }
}
