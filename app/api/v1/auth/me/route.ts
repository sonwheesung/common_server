// /api/v1/auth/me — 세션 확인 · 탈퇴(계정 삭제).
//
// ⚠ DELETE는 **Google Play 정책상 필수**다. 계정을 만드는 앱은 앱 안에서 계정 삭제를 요청할 수 있어야 하고,
//   웹에서도 삭제를 요청할 경로를 제공해야 한다(스토어 등록 정보에 URL 기재).
//   나중에 붙이면 심사에서 막히므로 로그인과 **같이** 만든다.
import { NextResponse } from 'next/server';
import { requireSubject, softDeleteSubject } from '../../../../../lib/auth/subject';
import { reportError } from '../../../../../lib/observability';

export const dynamic = 'force-dynamic';

const deny = () => NextResponse.json({ ok: false, reason: 'unauthorized' }, { status: 401 });

/** 세션이 아직 유효한지 + 내 정보. 앱이 부팅 시 토큰 유효성을 확인하는 용도. */
export async function GET(req: Request) {
  try {
    const authed = await requireSubject(req);
    if (!authed) return deny();
    const { subject } = authed;
    return NextResponse.json({
      ok: true,
      subject: { id: subject.id, email: subject.email, provider: subject.provider, createdAt: subject.createdAt },
    });
  } catch (e) {
    reportError(e, 'v1/auth/me:GET');
    return NextResponse.json({ ok: false, reason: 'error' }, { status: 500 });
  }
}

/**
 * 탈퇴. 행을 지우지 않고 가명화한다 — 문의가 이 주체를 참조하고 보관기간(3년) 동안 남아야 하기 때문이다.
 * 이메일은 즉시 파기되고, provider_id가 토움스톤이 되어 옛 토큰으로 부활할 수 없다.
 *
 * 문의 본문은 함께 지우지 않는다: 소비자 분쟁 기록이라 보관 의무가 있고, 이미 작성자 식별이
 * 불가능해졌으므로 개인정보로서의 성격이 사라진다. 보관기간이 지나면 파기 크론이 지운다.
 */
export async function DELETE(req: Request) {
  try {
    const authed = await requireSubject(req);
    if (!authed) return deny();
    await softDeleteSubject(authed.subject.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    reportError(e, 'v1/auth/me:DELETE');
    return NextResponse.json({ ok: false, reason: 'error' }, { status: 500 });
  }
}
