// /api/admin/billing?app=<appCode> — RevenueCat 웹훅 시크릿 · 엔타이틀먼트 키 · 현황.
//
// 시크릿은 **원문을 저장하지 않는다**(sha256만). 이 DB에 자격증명이 들어가는 첫 사례라
// 읽히는 사고가 "문의 본문 유출"에서 "엔타이틀먼트 위조 가능"으로 등급이 오르지 않게 한다.
// 원본은 RC 대시보드가 들고 있으므로 우리 쪽에 남길 이유가 없다.
import { NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { db } from '../../../../db';
import { apps, entitlements, purchaseEvents, subjects } from '../../../../db/schema';
import { isAdmin } from '../../../../lib/admin';
import { normalizeAppCode } from '../../../../lib/apps';
import { activeCount } from '../../../../lib/entitlement';
import { hashSecret, sandboxGrantEnabled, secretStrongEnough, viewOf } from '../../../../lib/revenuecat';
import { reportError } from '../../../../lib/observability';

export const dynamic = 'force-dynamic';

const deny = () => NextResponse.json({ ok: false, reason: 'unauthorized' }, { status: 401 });
const bad = (reason = 'bad-request') => NextResponse.json({ ok: false, reason }, { status: 400 });

const EVENT_LIMIT = 30;

export async function GET(req: Request) {
  if (!isAdmin(req)) return deny();
  try {
    const appCode = normalizeAppCode(new URL(req.url).searchParams.get('app'));
    if (!appCode) return bad();

    const app = (await db.select().from(apps).where(eq(apps.appCode, appCode)).limit(1))[0];
    if (!app) return NextResponse.json({ ok: false, reason: 'not-found' }, { status: 404 });

    const [active, events, subs] = await Promise.all([
      activeCount(appCode),
      db
        .select()
        .from(purchaseEvents)
        .where(eq(purchaseEvents.appCode, appCode))
        .orderBy(desc(purchaseEvents.createdAt))
        .limit(EVENT_LIMIT),
      db
        .select({
          subjectId: entitlements.subjectId,
          key: entitlements.key,
          expiresAt: entitlements.expiresAt,
          graceUntil: entitlements.graceUntil,
          willRenew: entitlements.willRenew,
          lastTxnId: entitlements.lastTxnId,
          revokedTxnId: entitlements.revokedTxnId,
          productId: entitlements.productId,
          environment: entitlements.environment,
          email: subjects.email,
        })
        .from(entitlements)
        .leftJoin(subjects, eq(subjects.id, entitlements.subjectId))
        .where(eq(entitlements.appCode, appCode))
        .orderBy(desc(entitlements.updatedAt))
        .limit(100),
    ]);

    return NextResponse.json({
      ok: true,
      // 해시조차 돌려주지 않는다 — 설정 여부만 알면 화면을 그릴 수 있다.
      configured: Boolean(app.rcWebhookSecretHash),
      entitlementKeys: app.entitlementKeys,
      // 출시 전에 꺼야 하는 스위치라 콘솔에서 보이게 한다(잊으면 테스트 결제가 실권한이 된다).
      sandboxGrant: sandboxGrantEnabled(),
      activeCount: active,
      subscribers: subs.map((s) => ({ ...s, ...viewOf(s) })),
      events,
    });
  } catch (e) {
    reportError(e, 'admin/billing:GET');
    return NextResponse.json({ ok: false, reason: 'error' }, { status: 500 });
  }
}

/**
 * 시크릿 등록/교체 · 키 목록 변경.
 *
 * `generate: true`면 서버가 32바이트 랜덤을 만들어 **한 번만** 돌려준다(해시는 저장, 원문은 버린다).
 * 사람이 값을 짓게 두면 sha256이 KDF가 아니라서 사전 대입에 뚫린다 — 그래서 생성을 기본으로 둔다.
 */
export async function PUT(req: Request) {
  if (!isAdmin(req)) return deny();
  try {
    const b = (await req.json()) as {
      appCode?: string;
      generate?: boolean;
      secret?: string;
      entitlementKeys?: string;
    };
    const appCode = normalizeAppCode(b.appCode);
    if (!appCode) return bad();

    const app = (await db.select().from(apps).where(eq(apps.appCode, appCode)).limit(1))[0];
    if (!app) return NextResponse.json({ ok: false, reason: 'not-found' }, { status: 404 });

    const set: { rcWebhookSecretHash?: string; entitlementKeys?: string } = {};
    let plaintext: string | null = null;

    if (b.generate) {
      plaintext = randomBytes(32).toString('base64url'); // 43자 — 사람이 외울 값이 아니다
      set.rcWebhookSecretHash = hashSecret(plaintext);
    } else if (typeof b.secret === 'string' && b.secret.trim()) {
      const raw = b.secret.trim();
      if (!secretStrongEnough(raw)) return bad('secret-too-weak');
      set.rcWebhookSecretHash = hashSecret(raw);
    }

    if (typeof b.entitlementKeys === 'string') {
      const keys = b.entitlementKeys
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
        .join(',');
      if (!keys) return bad('keys-required'); // 빈 목록 = 모든 이벤트 거부. 실수로 그렇게 되지 않게 막는다
      set.entitlementKeys = keys;
    }

    if (!Object.keys(set).length) return bad();
    await db.update(apps).set(set).where(eq(apps.appCode, appCode));

    // 원문은 이 응답에서만 존재한다. 다시 볼 수 없다 — RC 대시보드에 붙여넣고 끝내야 한다.
    return NextResponse.json({ ok: true, secret: plaintext, configured: true });
  } catch (e) {
    reportError(e, 'admin/billing:PUT');
    return NextResponse.json({ ok: false, reason: 'error' }, { status: 500 });
  }
}

/** 시크릿 폐기 — 그 앱 웹훅이 전면 거부로 돌아간다(fail-closed). */
export async function DELETE(req: Request) {
  if (!isAdmin(req)) return deny();
  try {
    const appCode = normalizeAppCode(new URL(req.url).searchParams.get('app'));
    if (!appCode) return bad();
    await db.update(apps).set({ rcWebhookSecretHash: null }).where(eq(apps.appCode, appCode));
    return NextResponse.json({ ok: true });
  } catch (e) {
    reportError(e, 'admin/billing:DELETE');
    return NextResponse.json({ ok: false, reason: 'error' }, { status: 500 });
  }
}
