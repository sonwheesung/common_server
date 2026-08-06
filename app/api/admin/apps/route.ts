// /api/admin/apps — 앱 레지스트리 관리. 여기 등록된 앱만 공개 라우트가 응답한다(allowlist).
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '../../../../db';
import { appSettings, apps } from '../../../../db/schema';
import { isAdmin } from '../../../../lib/admin';
import { normalizeAppCode } from '../../../../lib/apps';
import { reportError } from '../../../../lib/observability';

export const dynamic = 'force-dynamic';

const deny = () => NextResponse.json({ ok: false, reason: 'unauthorized' }, { status: 401 });
const bad = (reason = 'bad-request') => NextResponse.json({ ok: false, reason }, { status: 400 });

export async function GET(req: Request) {
  if (!isAdmin(req)) return deny();
  try {
    const rows = await db.select().from(apps).orderBy(apps.appCode);
    return NextResponse.json({ ok: true, apps: rows });
  } catch (e) {
    reportError(e, 'admin/apps:GET');
    return NextResponse.json({ ok: false, reason: 'error' }, { status: 500 });
  }
}

/** 앱 등록. settings 행도 같은 트랜잭션에서 만든다 — 설정 없는 앱이 부팅 게이트를 못 쓰는 상태를 원천 차단. */
export async function POST(req: Request) {
  if (!isAdmin(req)) return deny();
  try {
    const b = (await req.json()) as { appCode?: string; name?: string; ticketDailyCap?: number };
    const appCode = normalizeAppCode(b.appCode);
    const name = (b.name ?? '').trim().slice(0, 100);
    // app_code는 앱 번들·env 키(DISCORD_TICKET_WEBHOOK_URL_<CODE>)에 박히므로 문자셋을 좁게 강제한다.
    if (!/^[a-z0-9_]{2,64}$/.test(appCode) || !name) return bad();

    await db.transaction(async (tx) => {
      await tx
        .insert(apps)
        .values({
          appCode,
          name,
          ...(typeof b.ticketDailyCap === 'number' && b.ticketDailyCap > 0
            ? { ticketDailyCap: Math.floor(b.ticketDailyCap) }
            : {}),
        })
        .onConflictDoNothing({ target: apps.appCode });
      await tx.insert(appSettings).values({ appCode }).onConflictDoNothing({ target: appSettings.appCode });
    });

    const row = await db.select().from(apps).where(eq(apps.appCode, appCode)).limit(1);
    return NextResponse.json({ ok: true, app: row[0] });
  } catch (e) {
    reportError(e, 'admin/apps:POST');
    return NextResponse.json({ ok: false, reason: 'error' }, { status: 500 });
  }
}

/** 활성 토글·이름·캡 수정. app_code 자체는 바꿀 수 없다(앱 번들에 박힌 값이라 서버가 일방적으로 못 바꾼다). */
export async function PATCH(req: Request) {
  if (!isAdmin(req)) return deny();
  try {
    const b = (await req.json()) as { appCode?: string; name?: string; active?: boolean; ticketDailyCap?: number };
    const appCode = normalizeAppCode(b.appCode);
    if (!appCode) return bad();

    const patch: Record<string, unknown> = {};
    if (typeof b.name === 'string' && b.name.trim()) patch.name = b.name.trim().slice(0, 100);
    if (typeof b.active === 'boolean') patch.active = b.active;
    if (typeof b.ticketDailyCap === 'number' && b.ticketDailyCap > 0) patch.ticketDailyCap = Math.floor(b.ticketDailyCap);
    if (!Object.keys(patch).length) return bad('nothing-to-update');

    const updated = await db.update(apps).set(patch).where(eq(apps.appCode, appCode)).returning();
    if (!updated.length) return NextResponse.json({ ok: false, reason: 'not-found' }, { status: 404 });
    return NextResponse.json({ ok: true, app: updated[0] });
  } catch (e) {
    reportError(e, 'admin/apps:PATCH');
    return NextResponse.json({ ok: false, reason: 'error' }, { status: 500 });
  }
}
