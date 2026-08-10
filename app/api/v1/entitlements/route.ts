// GET /api/v1/entitlements — 내 엔타이틀먼트(구독). Bearer 세션 토큰.
//
// 구독자가 아니어도 200이다 — 없으면 `{}`. 404를 주면 앱이 "서버 오류"와 "미구독"을 구분하지 못하고,
// 그 차이는 **광고를 띄울지 말지**를 가른다.
//
// `checkedAt`을 함께 준다: 앱이 오프라인에서 광고를 안 띄우려면 캐시해야 하는데,
// 기기 시계가 틀어져 있으면 만료 판단이 어긋난다. 서버 시각을 같이 받으면 보정할 수 있다.
import { NextResponse } from 'next/server';
import { requireSubject } from '../../../../lib/auth/subject';
import { entitlementsOf } from '../../../../lib/entitlement';
import { reportError } from '../../../../lib/observability';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const authed = await requireSubject(req);
    if (!authed) return NextResponse.json({ ok: false, reason: 'unauthorized' }, { status: 401 });

    const entitlements = await entitlementsOf(authed.subject.id);
    return NextResponse.json({ ok: true, entitlements, checkedAt: new Date().toISOString() });
  } catch (e) {
    reportError(e, 'v1/entitlements');
    return NextResponse.json({ ok: false, reason: 'error' }, { status: 500 });
  }
}
