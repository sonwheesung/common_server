// POST /api/v1/devices — 비회원 앱의 기기 subject 등록 + 세션 토큰 발급 (2026-08-14, 첫 사용처 linkmemo).
//
// body: { app, deviceId }
//   deviceId는 앱이 최초 실행 시 만든 무작위 UUID(SecureStore 보관). 이 값이 곧 열쇠라
//   형식을 UUID로 강제한다(쓰레기 값·짧은 값으로 남의 subject를 추측하는 것 차단).
//
// 무인증 발급이 설계다 — 목적은 인증이 아니라 **귀속**이다(같은 기기의 문의를 묶어 답변을 돌려준다).
// 남용 방어: IP 레이트리밋(device 버킷) + 문의 쪽은 기존 앱별 일일 캡이 그대로 방어선.
import { NextResponse } from 'next/server';
import { getActiveApp } from '../../../../lib/apps';
import { ensureDeviceSubject } from '../../../../lib/auth/subject';
import { sessionReady, signSession } from '../../../../lib/auth/session';
import { checkLimit, clientIp } from '../../../../lib/ratelimit';
import { reportError } from '../../../../lib/observability';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: Request) {
  if (!(await checkLimit('device', clientIp(req))).ok) {
    return NextResponse.json({ ok: false, reason: 'rate-limited' }, { status: 429 });
  }

  // 시크릿이 없으면 토큰을 위조당할 수 있으므로 발급 자체를 막는다(fail-closed) — login과 동일.
  if (!sessionReady()) {
    return NextResponse.json({ ok: false, reason: 'not-configured' }, { status: 503 });
  }

  try {
    const b = (await req.json()) as { app?: string; deviceId?: string };

    const app = await getActiveApp(b.app);
    if (!app) return NextResponse.json({ ok: false, reason: 'not-found' }, { status: 404 });

    const deviceId = (b.deviceId ?? '').trim().toLowerCase();
    if (!UUID_RE.test(deviceId)) {
      return NextResponse.json({ ok: false, reason: 'bad-request' }, { status: 400 });
    }

    const subject = await ensureDeviceSubject(app.appCode, deviceId);
    if (subject.deletedAt) {
      // 가명화된(탈퇴) 행이 UNIQUE 충돌로 되살아나는 일은 없지만, 방어적으로 거부한다
      return NextResponse.json({ ok: false, reason: 'unauthorized' }, { status: 401 });
    }
    const token = signSession({ sid: subject.id, app: app.appCode });
    if (!token) return NextResponse.json({ ok: false, reason: 'not-configured' }, { status: 503 });

    return NextResponse.json({ ok: true, token, subject: { id: subject.id, email: null } });
  } catch (e) {
    reportError(e, 'v1/devices');
    return NextResponse.json({ ok: false, reason: 'error' }, { status: 500 });
  }
}
