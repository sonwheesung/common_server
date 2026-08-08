// /api/admin/auth-providers?app=<appCode> — 앱별 소셜 로그인 설정.
//
// audience(클라이언트 ID)는 앱 번들에 박히는 **공개값**이라 DB 보관이 안전하다(시크릿이 아니다).
// env가 아니라 DB인 이유는 `apps`와 같다 — 앱을 늘릴 때마다 재배포하지 않기 위해서.
import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '../../../../db';
import { appAuthProviders } from '../../../../db/schema';
import { isAdmin } from '../../../../lib/admin';
import { normalizeAppCode } from '../../../../lib/apps';
import { SUPPORTED_PROVIDERS, isProviderSupported } from '../../../../lib/auth/providers';
import { reportError } from '../../../../lib/observability';

export const dynamic = 'force-dynamic';

const deny = () => NextResponse.json({ ok: false, reason: 'unauthorized' }, { status: 401 });
const bad = (reason = 'bad-request') => NextResponse.json({ ok: false, reason }, { status: 400 });

export async function GET(req: Request) {
  if (!isAdmin(req)) return deny();
  try {
    const appCode = normalizeAppCode(new URL(req.url).searchParams.get('app'));
    if (!appCode) return bad();
    const rows = await db.select().from(appAuthProviders).where(eq(appAuthProviders.appCode, appCode));
    // 콘솔이 "설정 가능한 공급자"를 알 수 있게 지원 목록도 함께 준다 —
    // 검증기가 없는 공급자를 설정해봐야 로그인은 거부되므로, 애초에 고를 수 없어야 한다.
    return NextResponse.json({ ok: true, providers: rows, supported: SUPPORTED_PROVIDERS });
  } catch (e) {
    reportError(e, 'admin/auth-providers:GET');
    return NextResponse.json({ ok: false, reason: 'error' }, { status: 500 });
  }
}

/** 등록/수정(업서트). 공급자당 1행이라 PUT 하나로 다룬다. */
export async function PUT(req: Request) {
  if (!isAdmin(req)) return deny();
  try {
    const b = (await req.json()) as { appCode?: string; provider?: string; audiences?: string; enabled?: boolean };
    const appCode = normalizeAppCode(b.appCode);
    const provider = (b.provider ?? '').trim().toLowerCase();
    if (!appCode || !provider) return bad();
    // 미구현 공급자는 저장조차 막는다 — 설정해두면 "켰는데 왜 안 되지"로 시간을 버린다
    if (!isProviderSupported(provider)) return bad('provider-not-supported');

    // 콤마 구분 정규화(공백·빈 항목 제거) — 저장 시점에 정리해야 검증에서 빈 문자열이 audience로 새지 않는다
    const audiences = (b.audiences ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .join(',');
    if (!audiences) return bad('audiences-required');

    const enabled = b.enabled !== false;
    const now = new Date();

    await db
      .insert(appAuthProviders)
      .values({ appCode, provider, audiences, enabled, updatedAt: now })
      .onConflictDoUpdate({
        target: [appAuthProviders.appCode, appAuthProviders.provider],
        set: { audiences, enabled, updatedAt: now },
      });

    const rows = await db
      .select()
      .from(appAuthProviders)
      .where(and(eq(appAuthProviders.appCode, appCode), eq(appAuthProviders.provider, provider)))
      .limit(1);
    return NextResponse.json({ ok: true, provider: rows[0] });
  } catch (e) {
    reportError(e, 'admin/auth-providers:PUT');
    return NextResponse.json({ ok: false, reason: 'error' }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  if (!isAdmin(req)) return deny();
  try {
    const q = new URL(req.url).searchParams;
    const appCode = normalizeAppCode(q.get('app'));
    const provider = (q.get('provider') ?? '').trim().toLowerCase();
    if (!appCode || !provider) return bad();
    await db
      .delete(appAuthProviders)
      .where(and(eq(appAuthProviders.appCode, appCode), eq(appAuthProviders.provider, provider)));
    return NextResponse.json({ ok: true });
  } catch (e) {
    reportError(e, 'admin/auth-providers:DELETE');
    return NextResponse.json({ ok: false, reason: 'error' }, { status: 500 });
  }
}
