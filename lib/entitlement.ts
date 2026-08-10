// 엔타이틀먼트 적용·조회 — 판정(lib/revenuecat.ts decideEvent)의 결과를 DB에 옮긴다.
//
// 판정과 적용을 나눈 이유: 가드가 DB 없이 판단만 검증할 수 있어야 하고,
// 여기서는 "어떻게 저장하느냐"(멱등·순서)만 신경 쓰면 되기 때문이다.
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { entitlements, purchaseEvents, subjects, type Entitlement } from '../db/schema';
import { nextState, viewOf, type Decision, type EntitlementView, type RcEvent } from './revenuecat';

/** 감사행이 남았는가 / 이미 있던 이벤트인가. */
export type ApplyResult =
  | { status: 'applied' | 'ignored' | 'rejected'; reason?: string }
  | { status: 'deduped' };

const RAW_MAX = 4000; // 원문은 사후 재구성용이라 통째로 둘 필요는 없다

/**
 * 이벤트 1건 적용. **감사행 기록과 상태 변경을 한 트랜잭션으로 묶는다** —
 * 나누면 "기록만 남고 미적용" 또는 그 반대의 크래시 창이 생긴다.
 *
 * 멱등은 purchase_events.rc_event_id UNIQUE가 만든다. RC는 웹훅을 재전송하므로
 * 이게 없으면 같은 갱신이 만료시각을 두 번 민다.
 */
export async function applyEvent(appCode: string, raw: RcEvent, d: Decision): Promise<ApplyResult> {
  const rcEventId = (raw.id ?? '').trim();
  // id가 없는 이벤트는 멱등키가 없다 — 적용하면 재전송 시 이중 반영된다. 기록만 남기고 거부한다.
  if (!rcEventId) return { status: 'rejected', reason: 'no-event-id' };

  return db.transaction(async (tx) => {
    const audit = {
      appCode,
      rcEventId,
      type: (raw.type ?? '').toUpperCase(),
      appUserId: raw.app_user_id ?? null,
      subjectId: null as string | null,
      productId: d.productId ?? null,
      entitlementKey: d.key ?? null,
      storeTxnId: d.txnId ?? null,
      environment: d.environment ?? null,
      outcome: d.outcome as string,
      reason: d.reason ?? null,
      eventAt: d.eventAt ?? null,
      raw: JSON.stringify(raw).slice(0, RAW_MAX),
    };

    // 적용 대상이면 주체가 **이 앱의 살아있는 주체**인지 확인한다.
    // app을 대조하지 않으면 다른 앱의 subject_id를 아는 사람이 그 앱 권한을 만들 수 있다.
    let subject: { id: string; appCode: string; deletedAt: Date | null } | null = null;
    if (d.outcome === 'applied' && d.subjectId) {
      const rows = await tx
        .select({ id: subjects.id, appCode: subjects.appCode, deletedAt: subjects.deletedAt })
        .from(subjects)
        .where(eq(subjects.id, d.subjectId))
        .limit(1);
      subject = rows[0] ?? null;
    }

    if (d.outcome === 'applied' && (!subject || subject.appCode !== appCode)) {
      audit.outcome = 'rejected';
      audit.reason = 'unknown-subject';
    } else if (d.outcome === 'applied' && subject?.deletedAt) {
      // 탈퇴한 주체 — 되돌릴 게 없고 **영원히 같은 이유로 실패한다**.
      // 여기서 실패로 다루면 RC가 백오프로 재전송하며 에러 지표를 같은 이벤트 복제로 채운다.
      audit.outcome = 'ignored';
      audit.reason = 'subject-deleted';
    } else if (subject) {
      audit.subjectId = subject.id;
    }

    // 감사행 먼저. 충돌하면 이미 처리한 이벤트다(재전송) → 상태를 건드리지 않고 빠져나간다.
    const inserted = await tx.insert(purchaseEvents).values(audit).onConflictDoNothing().returning({ id: purchaseEvents.id });
    if (!inserted.length) return { status: 'deduped' };

    if (audit.outcome !== 'applied' || !subject) {
      return { status: audit.outcome as 'ignored' | 'rejected', reason: audit.reason ?? undefined };
    }

    // ── 소유자 이전 ── 옛 주체에게서 회수하고 새 주체에 붙인다.
    // RC의 이전은 공유가 아니라 **이동**이다(동시에 한 계정만 가진다).
    if (d.transferFrom?.length) {
      await tx
        .update(entitlements)
        .set({ expiresAt: d.eventAt ?? new Date(), willRenew: false, updatedAt: new Date() })
        .where(and(eq(entitlements.key, d.key!), inArray(entitlements.subjectId, d.transferFrom)));
    }

    await upsertEntitlement(tx, appCode, subject.id, d);
    return { status: 'applied' };
  });
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * 상태 반영. 계산은 전부 `nextState()`(순수)가 하고 여기서는 읽고 쓰기만 한다 —
 * 순서역전·환불 후 갱신 같은 판단이 DB 안에 숨으면 가드가 검증할 수 없다.
 */
async function upsertEntitlement(tx: Tx, appCode: string, subjectId: string, d: Decision): Promise<void> {
  const key = d.key!;
  const existing = (
    await tx
      .select()
      .from(entitlements)
      .where(and(eq(entitlements.subjectId, subjectId), eq(entitlements.key, key)))
      .limit(1)
  )[0] as Entitlement | undefined;

  const next = nextState(existing ?? null, d);
  if (!next) return; // 과거 이벤트 — 감사행은 이미 남았다

  const row = { appCode, subjectId, key, ...next, updatedAt: new Date() };
  await tx
    .insert(entitlements)
    .values(row)
    .onConflictDoUpdate({ target: [entitlements.subjectId, entitlements.key], set: row });
}

/** 주체의 엔타이틀먼트 전부 → 앱이 읽는 모양. 없으면 빈 객체(404가 아니다). */
export async function entitlementsOf(subjectId: string): Promise<Record<string, EntitlementView>> {
  const rows = await db.select().from(entitlements).where(eq(entitlements.subjectId, subjectId));
  const out: Record<string, EntitlementView> = {};
  for (const r of rows) out[r.key] = viewOf(r);
  return out;
}

/** 콘솔용 — 앱의 활성 구독 수. `active`를 저장하지 않으므로 조건을 여기서 편다. */
export async function activeCount(appCode: string, key = 'pro'): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(entitlements)
    .where(
      and(
        eq(entitlements.appCode, appCode),
        eq(entitlements.key, key),
        sql`(${entitlements.revokedTxnId} is null or ${entitlements.revokedTxnId} <> ${entitlements.lastTxnId})`,
        sql`(${entitlements.expiresAt} > now() or ${entitlements.graceUntil} > now())`,
      ),
    );
  return rows[0]?.n ?? 0;
}
