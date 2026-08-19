// 엔타이틀먼트 적용·조회 — 판정(lib/revenuecat.ts decideEvent)의 결과를 DB에 옮긴다.
//
// 판정과 적용을 나눈 이유: 가드가 DB 없이 판단만 검증할 수 있어야 하고,
// 여기서는 "어떻게 저장하느냐"(멱등·순서)만 신경 쓰면 되기 때문이다.
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { apps, entitlements, purchaseEvents, subjects, type Entitlement } from '../db/schema';
import { nextState, viewOf, type Decision, type EntState, type EntitlementView, type RcEvent } from './revenuecat';
import {
  PULL_COOLDOWN_SEC,
  PULL_RETRY_SEC,
  fetchSnapshot,
  pullEventId,
  rcSecretKey,
  runPull,
  type PullGate,
  type PullResult,
} from './rcPull';

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
      expiresAt: null as Date | null, // 아래에서 nextState()의 결과로 채운다
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

    // 상태 전이를 **감사행보다 먼저 계산한다**(읽기·순수 계산뿐 — 쓰기 순서는 그대로다).
    // 그래야 "이 이벤트가 만들어낸 만료"를 감사행에 적을 수 있다.
    let existing: Entitlement | undefined;
    let next: EntState | null = null;
    if (audit.outcome === 'applied' && subject && d.key) {
      existing = await readEntitlement(tx, subject.id, d.key);
      next = nextState(existing ?? null, d);
      audit.expiresAt = next?.expiresAt ?? null;
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

    await writeEntitlement(tx, appCode, subject.id, d.key!, next);
    return { status: 'applied' };
  });
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * 상태 반영. 계산은 전부 `nextState()`(순수)가 하고 여기서는 읽고 쓰기만 한다 —
 * 순서역전·환불 후 갱신 같은 판단이 DB 안에 숨으면 가드가 검증할 수 없다.
 */
async function writeEntitlement(
  tx: Tx,
  appCode: string,
  subjectId: string,
  key: string,
  next: EntState | null,
): Promise<boolean> {
  if (!next) return false; // 과거 이벤트 — 감사행은 이미 남았다

  const row = { appCode, subjectId, key, ...next, updatedAt: new Date() };
  await tx
    .insert(entitlements)
    .values(row)
    .onConflictDoUpdate({ target: [entitlements.subjectId, entitlements.key], set: row });
  return true;
}

async function readEntitlement(tx: Tx, subjectId: string, key: string): Promise<Entitlement | undefined> {
  return (
    await tx
      .select()
      .from(entitlements)
      .where(and(eq(entitlements.subjectId, subjectId), eq(entitlements.key, key)))
      .limit(1)
  )[0] as Entitlement | undefined;
}

// ───────────────────────── pull 적용 ─────────────────────────

/**
 * 스냅샷 판정 1건 적용. `applyEvent`와 갈라 둔 이유:
 * 저긴 `rcEventId`(RC가 준 것)를 멱등키로 쓰고 RcEvent 모양을 전제한다. 스냅샷엔 이벤트 id가 없다.
 * **상태 전이는 `nextState()`로 같은 것을 쓴다** — 갈리는 것은 입력 파싱과 멱등키뿐이다.
 */
export async function applyPull(appCode: string, subjectId: string, d: Decision): Promise<ApplyResult> {
  return db.transaction(async (tx) => {
    const subject = (
      await tx
        .select({ id: subjects.id, appCode: subjects.appCode, deletedAt: subjects.deletedAt })
        .from(subjects)
        .where(eq(subjects.id, subjectId))
        .limit(1)
    )[0];
    if (!subject || subject.appCode !== appCode) return { status: 'rejected', reason: 'unknown-subject' };
    if (subject.deletedAt) return { status: 'ignored', reason: 'subject-deleted' };
    if (d.outcome !== 'applied' || !d.key) return { status: 'ignored', reason: d.reason };

    const existing = await readEntitlement(tx, subjectId, d.key);
    // 행도 없고 줄 것도 없다 = 그냥 미구독자다. 감사행을 남기면 미구독자 수만큼 행이 생긴다.
    if (!existing && !d.expiresAt && !d.graceUntil) return { status: 'ignored', reason: 'no-subscription' };

    const next = nextState(existing ?? null, d);

    const audit = {
      appCode,
      rcEventId: pullEventId(subjectId, d), // 결정적 합성키 — 같은 스냅샷 반복 pull은 UNIQUE가 접는다
      type: 'PULL',
      appUserId: subjectId,
      subjectId,
      productId: d.productId ?? null,
      entitlementKey: d.key,
      storeTxnId: d.txnId ?? null,
      environment: d.environment ?? null,
      outcome: 'applied',
      reason: null as string | null,
      eventAt: d.eventAt ?? null,
      expiresAt: next?.expiresAt ?? null,
      raw: JSON.stringify({ source: 'pull', expiresAt: d.expiresAt, graceUntil: d.graceUntil, willRenew: d.willRenew }),
    };

    const inserted = await tx.insert(purchaseEvents).values(audit).onConflictDoNothing().returning({ id: purchaseEvents.id });
    // 충돌 = 직전 pull과 같은 스냅샷이다. 상태도 같으므로 건드릴 것이 없다.
    if (!inserted.length) return { status: 'deduped' };

    const applied = await writeEntitlement(tx, appCode, subjectId, d.key, next);
    return applied ? { status: 'applied' } : { status: 'ignored', reason: 'stale-snapshot' };
  });
}

// ───────────────────────── pull 쿨다운(= 락) ─────────────────────────

/**
 * 조건부 UPDATE 한 문장이 **쿨다운과 동시성 락을 동시에** 준다.
 * Redis 카운터는 read-then-write 사이가 벌어져 동시 요청이 둘 다 통과할 수 있다 — 여기선 원자적이다.
 */
export const pullGate: PullGate = {
  async claim(subjectId, cooldownSec) {
    const rows = await db
      .update(subjects)
      .set({ rcPulledAt: sql`now()` })
      .where(
        and(
          eq(subjects.id, subjectId),
          sql`(${subjects.rcPulledAt} is null or ${subjects.rcPulledAt} < now() - make_interval(secs => ${cooldownSec}))`,
        ),
      )
      .returning({ id: subjects.id });
    return rows.length > 0;
  },

  /**
   * 실패 롤백. 스탬프를 "가장 긴 쿨다운 − 재시도 지연"만큼 과거로 당긴다 —
   * 그래야 6시간 경로에서도 PULL_RETRY_SEC 뒤에 창이 열린다. 그동안은 여전히 잠겨 있어 폭주하지 않는다.
   * ⚠ 여기 오는 것은 네트워크·타임아웃·5xx·인증 실패뿐이다. 200 "구독 없음"은 정상 답이라 쿨다운을 태운다.
   */
  async release(subjectId) {
    await db
      .update(subjects)
      .set({ rcPulledAt: sql`now() - make_interval(secs => ${PULL_COOLDOWN_SEC - PULL_RETRY_SEC})` })
      .where(eq(subjects.id, subjectId));
  },
};

/**
 * 이 앱·주체로 pull 1회. 라우트가 부르는 진입점 — **던지지 않는다**(runPull이 전부 삼킨다).
 * 허용 키는 웹훅과 같은 자리(`apps.entitlementKeys`)에서 온다. 두 경로가 다른 필터를 쓰면 갈린다.
 */
export async function pullEntitlements(
  appCode: string,
  subjectId: string,
  opts: { fresh?: boolean; cooldownSec?: number } = {},
): Promise<PullResult> {
  // 키가 없으면 apps 조회조차 하지 않는다 — 이 배포엔 pull이 없다.
  if (!rcSecretKey(appCode)) return { status: 'skipped', reason: 'unconfigured', changed: false };
  try {
    const app = (await db.select({ keys: apps.entitlementKeys }).from(apps).where(eq(apps.appCode, appCode)).limit(1))[0];
    if (!app) return { status: 'skipped', reason: 'unknown-app', changed: false };
    return runPull(
      { gate: pullGate, fetch: fetchSnapshot, apply: applyPull },
      appCode,
      subjectId,
      app.keys.split(','),
      opts,
    );
  } catch {
    return { status: 'failed', reason: 'db', changed: false };
  }
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
