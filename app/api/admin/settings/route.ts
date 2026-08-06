// /api/admin/settings?app=<appCode> — 앱별 부팅 게이트(강제 업데이트·점검) 설정.
// 이 값들이 곧 앱 진입 차단 스위치다. 스토어 심사를 기다리지 않고 서버에서 막을 수 있는 유일한 경로라
// 잘못 켜면 전 사용자가 즉시 못 들어온다 — 콘솔에서 확인 문구를 한 번 받는다(app/ops 쪽).
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '../../../../db';
import { appSettings } from '../../../../db/schema';
import { isAdmin } from '../../../../lib/admin';
import { normalizeAppCode } from '../../../../lib/apps';
import { reportError } from '../../../../lib/observability';

export const dynamic = 'force-dynamic';

const deny = () => NextResponse.json({ ok: false, reason: 'unauthorized' }, { status: 401 });
const clipOrNull = (v: unknown, max: number): string | null =>
  typeof v === 'string' ? (v.trim() ? v.trim().slice(0, max) : null) : null;

export async function GET(req: Request) {
  if (!isAdmin(req)) return deny();
  try {
    const appCode = normalizeAppCode(new URL(req.url).searchParams.get('app'));
    if (!appCode) return NextResponse.json({ ok: false, reason: 'bad-request' }, { status: 400 });
    const rows = await db.select().from(appSettings).where(eq(appSettings.appCode, appCode)).limit(1);
    if (!rows.length) return NextResponse.json({ ok: false, reason: 'not-found' }, { status: 404 });
    return NextResponse.json({ ok: true, settings: rows[0] });
  } catch (e) {
    reportError(e, 'admin/settings:GET');
    return NextResponse.json({ ok: false, reason: 'error' }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  if (!isAdmin(req)) return deny();
  try {
    const b = (await req.json()) as Record<string, unknown>;
    const appCode = normalizeAppCode(b.appCode);
    if (!appCode) return NextResponse.json({ ok: false, reason: 'bad-request' }, { status: 400 });

    // 빈 문자열은 null로 정규화한다 — "지웠다"와 "안 건드렸다"를 구분하려고 키 존재 여부로 판단.
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if ('minVersion' in b) patch.minVersion = clipOrNull(b.minVersion, 32);
    if ('latestVersion' in b) patch.latestVersion = clipOrNull(b.latestVersion, 32);
    if ('androidStoreUrl' in b) patch.androidStoreUrl = clipOrNull(b.androidStoreUrl, 500);
    if ('iosStoreUrl' in b) patch.iosStoreUrl = clipOrNull(b.iosStoreUrl, 500);
    if ('maintenance' in b) patch.maintenance = Boolean(b.maintenance);
    if ('maintenanceTitle' in b) patch.maintenanceTitle = clipOrNull(b.maintenanceTitle, 200);
    if ('maintenanceBody' in b) patch.maintenanceBody = clipOrNull(b.maintenanceBody, 2000);

    const updated = await db.update(appSettings).set(patch).where(eq(appSettings.appCode, appCode)).returning();
    if (!updated.length) return NextResponse.json({ ok: false, reason: 'not-found' }, { status: 404 });
    return NextResponse.json({ ok: true, settings: updated[0] });
  } catch (e) {
    reportError(e, 'admin/settings:PATCH');
    return NextResponse.json({ ok: false, reason: 'error' }, { status: 500 });
  }
}
