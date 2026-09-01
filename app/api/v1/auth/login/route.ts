// POST /api/v1/auth/login — 소셜 로그인 → 우리 세션 토큰 발급.
//
// body: { app, provider, idToken }
//   provider는 지금 'google'만 구현돼 있다. 카카오·애플은 검증기를 붙이면 이 라우트를 고치지 않고 열린다.
//
// 실패 사유를 세분화하지 않는다: 토큰이 틀렸는지, 앱에 그 공급자가 설정 안 됐는지, 미구현 공급자인지를
// 구분해 주면 공격자가 우리 설정을 탐색할 수 있다. 전부 401 'unauthorized'로 뭉갠다.
// (설정 실수 진단은 관리자 콘솔에서 하면 된다 — 공개 라우트가 알려줄 일이 아니다.)
import { NextResponse } from 'next/server';
import { getActiveApp } from '../../../../../lib/apps';
import { isProviderSupported, verifyProviderToken } from '../../../../../lib/auth/providers';
import { ensureSubject, providerConfig } from '../../../../../lib/auth/subject';
import { sessionReady, signSession } from '../../../../../lib/auth/session';
import { recordActive } from '../../../../../lib/activity';
import { afterSafe } from '../../../../../lib/afterSafe';
import { checkLimit, clientIp } from '../../../../../lib/ratelimit';
import { reportError } from '../../../../../lib/observability';

export const dynamic = 'force-dynamic';

const deny = () => NextResponse.json({ ok: false, reason: 'unauthorized' }, { status: 401 });

export async function POST(req: Request) {
  if (!(await checkLimit('login', clientIp(req))).ok) {
    return NextResponse.json({ ok: false, reason: 'rate-limited' }, { status: 429 });
  }

  // 시크릿이 없으면 토큰을 위조당할 수 있으므로 발급 자체를 막는다(fail-closed).
  // 401이 아니라 503인 이유: 이건 사용자 잘못이 아니라 서버 설정 문제이고, 앱이 재시도해도 된다.
  if (!sessionReady()) {
    return NextResponse.json({ ok: false, reason: 'not-configured' }, { status: 503 });
  }

  try {
    const b = (await req.json()) as { app?: string; provider?: string; idToken?: string };

    const app = await getActiveApp(b.app);
    if (!app) return NextResponse.json({ ok: false, reason: 'not-found' }, { status: 404 });

    const provider = (b.provider ?? '').trim().toLowerCase();
    // 검증기가 없는 공급자는 설정에서 켜져 있어도 거부한다 — 미검증 로그인은 곧 계정 도용이다
    if (!isProviderSupported(provider)) return deny();

    const audiences = await providerConfig(app.appCode, provider);
    if (!audiences) return deny(); // 앱에 그 공급자가 설정되지 않았거나 audience가 비었다

    const identity = await verifyProviderToken(provider, (b.idToken ?? '').trim(), audiences);
    if (!identity) return deny();

    const subject = await ensureSubject(app.appCode, provider, identity.providerId, identity.email);
    const token = signSession({ sid: subject.id, app: app.appCode });
    if (!token) return NextResponse.json({ ok: false, reason: 'not-configured' }, { status: 503 });

    // 활성 하트비트 — 로그인 직후에는 bootstrap에 아직 토큰이 없어 그날이 비는 것을 막는다(devices와 같은 이유).
    afterSafe(() => recordActive(app.appCode, subject.id));

    // providerId는 돌려주지 않는다 — 앱이 쓸 데가 없고, 로그에 남으면 계정 식별자가 새어나간다.
    return NextResponse.json({
      ok: true,
      token,
      subject: { id: subject.id, email: subject.email },
    });
  } catch (e) {
    reportError(e, 'v1/auth/login');
    return NextResponse.json({ ok: false, reason: 'error' }, { status: 500 });
  }
}
