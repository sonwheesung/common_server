// RevenueCat 웹훅 — 인증 · 순수판정 · 적용.
//
// 설계의 요점 하나: **`active`를 저장하지 않는다.** 만료시각을 두고 읽을 때 계산한다(db/schema.ts 주석).
// 그래서 갱신 계열은 `max()`로만 움직이고, 도착 순서가 뒤바뀌어도 같은 상태로 수렴한다.
// 만료를 **앞당길 수 있는** PRODUCT_CHANGE·EXPIRATION만 덮어쓰기라 시각 가드가 붙는다.
//
// 판정(decideEvent)은 DB를 모른다 — 가드가 데이터베이스 없이 판단만 검증할 수 있어야 하기 때문이다.
import { createHash, timingSafeEqual } from 'node:crypto';

/** RC 웹훅 바디에서 우리가 쓰는 부분만. RC는 필드를 늘리므로 전체를 타입으로 박지 않는다. */
export interface RcEvent {
  id?: string;
  type?: string;
  app_user_id?: string;
  original_app_user_id?: string;
  product_id?: string;
  entitlement_ids?: string[] | null;
  /** 단수형 레거시 필드. 일부 이벤트가 배열 대신 이걸 싣는다. */
  entitlement_id?: string | null;
  period_type?: string; // NORMAL | TRIAL | INTRO
  environment?: string; // PRODUCTION | SANDBOX
  event_timestamp_ms?: number;
  purchased_at_ms?: number;
  expiration_at_ms?: number | null;
  grace_period_expiration_at_ms?: number | null;
  transaction_id?: string | null;
  original_transaction_id?: string | null;
  cancel_reason?: string | null;
  transferred_from?: string[] | null;
  transferred_to?: string[] | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 만료시각을 **앞으로만** 미는 이벤트. max()로 합쳐지므로 순서를 안 탄다. */
const EXTEND = new Set(['INITIAL_PURCHASE', 'RENEWAL', 'UNCANCELLATION', 'NON_RENEWING_PURCHASE']);
/** 만료시각을 **뒤로 당길 수 있는** 이벤트. 덮어쓰기라 lastEventAt 가드가 필요하다. */
const OVERWRITE = new Set(['PRODUCT_CHANGE', 'EXPIRATION']);

// ───────────────────────── 인증 ─────────────────────────

const MIN_SECRET_LEN = 32; // sha256은 KDF가 아니다 — 사람이 지은 짧은 값은 사전 대입에 뚫린다

export const hashSecret = (raw: string): string => createHash('sha256').update(raw, 'utf8').digest('hex');

/** 시크릿으로 쓸 수 있는 값인지. 콘솔이 32바이트 랜덤을 생성해주므로 사람이 짧게 지을 여지를 막는다. */
export const secretStrongEnough = (raw: string): boolean => raw.trim().length >= MIN_SECRET_LEN;

/**
 * `Authorization: <시크릿>` 검증. 저장된 해시가 없으면 **전면 거부**(fail-closed).
 * RC 대시보드는 헤더 값을 그대로 보내므로 Bearer 접두사는 있을 수도 없을 수도 있다 — 둘 다 받는다.
 */
export function verifyWebhookAuth(req: Request, storedHash: string | null): boolean {
  if (!storedHash) return false;
  const raw = (req.headers.get('authorization') ?? '').trim();
  if (!raw) return false;
  const value = /^Bearer\s+/i.test(raw) ? raw.replace(/^Bearer\s+/i, '').trim() : raw;
  if (!value) return false;
  const a = Buffer.from(hashSecret(value), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * 샌드박스 지급 스위치. **미설정=off(fail-closed)**.
 *
 * 배구 실측: Play 라이선스 테스터가 내부 테스트 트랙에서 실제 결제해도 RC는 `environment=SANDBOX`로 보낸다.
 * 즉 이 스위치가 off면 테스트 결제가 전부 필터돼 검증 자체를 못 한다. 출시 전 off로 되돌릴 것.
 * env는 호출 시점에 읽는다 — 모듈 로드 시 캐시하면 재배포 없이 못 끈다.
 */
export const sandboxGrantEnabled = (): boolean => (process.env.RC_SANDBOX_GRANT ?? '') === 'all';

// ───────────────────────── 순수판정 ─────────────────────────

export type Outcome = 'applied' | 'ignored' | 'rejected';

export interface Decision {
  outcome: Outcome;
  reason?: string;
  subjectId?: string;
  key?: string;
  /** 만료시각 갱신 방식. extend=max(), overwrite=덮어쓰기(시각 가드), none=안 건드림 */
  mode?: 'extend' | 'overwrite' | 'none';
  expiresAt?: Date | null;
  graceUntil?: Date | null;
  willRenew?: boolean;
  /** 이 거래를 회수한다(환불). 판정은 revokedTxnId=lastTxnId 비교로 이뤄진다. */
  revoke?: boolean;
  txnId?: string | null;
  productId?: string | null;
  eventAt?: Date | null;
  environment?: string;
  /** TRANSFER: 이 주체들에게서 회수하고 subjectId로 옮긴다. */
  transferFrom?: string[];
}

const ms = (v: number | null | undefined): Date | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? new Date(v) : null;

/** RC가 실어 보내는 엔타이틀먼트 키. 배열이 표준이고 단수형은 레거시 폴백. */
function eventKeys(e: RcEvent): string[] {
  const list = Array.isArray(e.entitlement_ids) ? e.entitlement_ids : [];
  const single = e.entitlement_id ? [e.entitlement_id] : [];
  return [...list, ...single].map((k) => String(k).trim().toLowerCase()).filter(Boolean);
}

/**
 * 이벤트 → 무엇을 할지. **DB를 모른다.**
 *
 * `allowedKeys`는 RC 대시보드 오타가 유령 엔타이틀먼트를 만드는 걸 막는 필터다.
 * 상품→키 매핑이 아니다 — 매핑을 우리가 들면 RC의 attach 누락(빈 배열)이 우리 매핑에 가려진다.
 */
export function decideEvent(e: RcEvent, allowedKeys: string[]): Decision {
  const type = (e.type ?? '').trim().toUpperCase();
  const eventAt = ms(e.event_timestamp_ms);
  const environment = (e.environment ?? 'PRODUCTION').toUpperCase();
  const txnId = e.transaction_id ?? e.original_transaction_id ?? null;
  const productId = e.product_id ?? null;
  const base = { txnId, productId, eventAt, environment };

  // TEST 이벤트(RC 대시보드 "Send Test Webhook")는 200으로 받되 아무것도 바꾸지 않는다.
  // 여기서 500을 주면 연결 확인 자체가 실패한 것처럼 보인다.
  if (type === 'TEST') return { outcome: 'ignored', reason: 'test-event', ...base };

  // 샌드박스는 기본 무시. 스위치가 켜져 있으면 정상 처리하되 environment를 행에 남겨 나중에 걸러낼 수 있게 한다.
  if (environment === 'SANDBOX' && !sandboxGrantEnabled()) {
    return { outcome: 'ignored', reason: 'sandbox', ...base };
  }

  // app_user_id = subject_id 규약. RC 익명 ID면 매칭할 방법이 영영 없다 —
  // **조용히 넘기지 않고** 반드시 기록한다. 안 그러면 "결제는 됐는데 권한이 없다"의 원인을 못 찾는다.
  const appUserId = (e.app_user_id ?? '').trim();
  if (!appUserId || appUserId.startsWith('$RCAnonymousID') || !UUID_RE.test(appUserId)) {
    return { outcome: 'rejected', reason: 'anonymous-app-user-id', ...base };
  }

  const keys = eventKeys(e);
  if (!keys.length) {
    // RC에서 엔타이틀먼트에 **상품을 attach하지 않으면** 여기가 빈다.
    // "결제는 됐는데 광고가 계속 나온다"의 대표 원인이라 사유를 따로 남긴다.
    return { outcome: 'rejected', reason: 'no-entitlement-ids', subjectId: appUserId, ...base };
  }
  const allow = new Set(allowedKeys.map((k) => k.trim().toLowerCase()).filter(Boolean));
  const key = keys.find((k) => allow.has(k));
  if (!key) {
    return { outcome: 'rejected', reason: `unknown-key:${keys.join('|')}`, subjectId: appUserId, ...base };
  }

  const common = { subjectId: appUserId, key, ...base };
  const expiresAt = ms(e.expiration_at_ms);
  const graceUntil = ms(e.grace_period_expiration_at_ms);

  // ── 소유자 이전 ──
  // 탈퇴 후 재가입하면 subject_id가 새로 생긴다(가명화로 UNIQUE가 풀리므로). 그때 스토어 복원이
  // 이 이벤트를 만든다. 처리하지 않으면 "돈은 계속 나가는데 pro가 아닌" 상태가 된다.
  if (type === 'TRANSFER') {
    const from = (e.transferred_from ?? []).filter((v) => UUID_RE.test(v));
    return { ...common, outcome: 'applied', mode: 'none', transferFrom: from };
  }

  // ── 해지 예약 ──
  // **아직 활성이다.** 만료시각까지는 유효하고 자동갱신만 꺼진다. 여기서 끊으면 남은 기간을 뺏는 것이다.
  if (type === 'CANCELLATION') {
    return { ...common, outcome: 'applied', mode: 'none', willRenew: false };
  }

  // ── 환불 ──
  // 거래에 묶어 회수한다. 한 기간분만 환불되고 구독이 살아 있으면 다음 갱신(새 txn)에서 자동으로 풀린다.
  if (type === 'REFUND') {
    return { ...common, outcome: 'applied', mode: 'none', revoke: true, willRenew: false };
  }

  // ── 결제 실패 유예 ──
  // 여기서 바로 끊으면 카드 갱신 중인 사람의 백업이 멈춘다. 유예 만료시각까지 살린다.
  // 유예가 끝나면 RC가 EXPIRATION을 보낸다.
  if (type === 'BILLING_ISSUE') {
    return { ...common, outcome: 'applied', mode: 'none', graceUntil };
  }

  if (EXTEND.has(type)) {
    return {
      ...common,
      outcome: 'applied',
      mode: 'extend', // max() — 순서를 타지 않는다
      expiresAt,
      graceUntil: null, // 갱신됐으니 유예 해제
      willRenew: true,
    };
  }

  if (OVERWRITE.has(type)) {
    // 연간→월간 즉시 전환은 만료를 **앞당긴다**. max()면 긴 쪽이 남아 과다 지급이 되고
    // 뒤에 오는 EXPIRATION도 먹혀버린다. Play가 조기 만료시키는 경우도 같다.
    return {
      ...common,
      outcome: 'applied',
      mode: 'overwrite', // lastEventAt 가드가 붙는다
      expiresAt,
      graceUntil,
      willRenew: type === 'PRODUCT_CHANGE',
    };
  }

  // 모르는 타입은 무시하되 기록한다. RC가 이벤트를 추가해도 500을 뱉지 않아야 한다(재시도 폭풍).
  return { ...common, outcome: 'ignored', reason: `unhandled:${type}` };
}

// ───────────────────────── 상태 전이 ─────────────────────────

/** 저장되는 엔타이틀먼트 상태 중 판정에 쓰이는 부분. */
export interface EntState {
  expiresAt: Date | null;
  graceUntil: Date | null;
  willRenew: boolean;
  lastTxnId: string | null;
  revokedTxnId: string | null;
  revokedAt: Date | null;
  productId: string | null;
  environment: string;
  lastEventAt: Date | null;
}

export const EMPTY_STATE: EntState = {
  expiresAt: null,
  graceUntil: null,
  willRenew: true,
  lastTxnId: null,
  revokedTxnId: null,
  revokedAt: null,
  productId: null,
  environment: 'PRODUCTION',
  lastEventAt: null,
};

const later = (a: Date | null | undefined, b: Date | null | undefined): Date | null => {
  if (!a) return b ?? null;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
};

/**
 * (기존 상태, 판정) → 새 상태. **순수 함수** — 가드가 DB 없이 순서역전·멱등·환불 후 갱신을 검증할 수 있어야 한다.
 *
 * null을 돌려주면 "적용하지 않음"(과거 이벤트). 감사행은 이미 남았으므로 조용히 사라지지 않는다.
 */
export function nextState(prev: EntState | null, d: Decision, now: Date = new Date()): EntState | null {
  const existing = prev ?? EMPTY_STATE;

  // 덮어쓰기 계열만 순서를 탄다. 갱신 계열은 max()라 이 가드가 필요 없다(그게 이 설계의 요점).
  if (d.mode === 'overwrite' && existing.lastEventAt && d.eventAt && d.eventAt <= existing.lastEventAt) {
    return null;
  }

  const expiresAt =
    d.mode === 'extend'
      ? later(existing.expiresAt, d.expiresAt) // 교환법칙 — 도착 순서와 무관
      : d.mode === 'overwrite'
        ? (d.expiresAt ?? null)
        : existing.expiresAt;

  // undefined = 안 건드림, null = 해제. 갱신되면 유예를 푼다.
  const graceUntil = d.graceUntil !== undefined ? d.graceUntil : existing.graceUntil;

  // 거래 id는 갱신 계열에서만 전진한다 — 이게 회수 판정(revokedTxnId 비교)의 기준이다.
  const lastTxnId = d.mode === 'none' ? (existing.lastTxnId ?? d.txnId ?? null) : (d.txnId ?? existing.lastTxnId ?? null);

  return {
    expiresAt,
    graceUntil,
    willRenew: d.willRenew ?? existing.willRenew,
    lastTxnId,
    revokedTxnId: d.revoke ? (d.txnId ?? existing.lastTxnId ?? null) : existing.revokedTxnId,
    revokedAt: d.revoke ? now : existing.revokedAt,
    productId: d.productId ?? existing.productId,
    environment: d.environment ?? existing.environment,
    lastEventAt: later(existing.lastEventAt, d.eventAt),
  };
}

// ───────────────────────── 읽기 ─────────────────────────

export interface EntitlementView {
  active: boolean;
  expiresAt: string | null;
  willRenew: boolean;
  inGracePeriod: boolean;
}

/** 저장된 행 → 앱이 읽는 모양. **여기가 유일한 active 판정 지점이다.** */
export function viewOf(
  row: {
    expiresAt: Date | null;
    graceUntil: Date | null;
    willRenew: boolean;
    lastTxnId: string | null;
    revokedTxnId: string | null;
  },
  now: Date = new Date(),
): EntitlementView {
  // 회수를 거래로 판정한다 — 영구 플래그면 부분 환불 후 갱신이 와도 영원히 비활성이다.
  const revoked = row.revokedTxnId !== null && row.revokedTxnId === row.lastTxnId;
  const inGracePeriod = !revoked && row.graceUntil !== null && row.graceUntil.getTime() > now.getTime();
  const notExpired = row.expiresAt !== null && row.expiresAt.getTime() > now.getTime();
  return {
    active: !revoked && (notExpired || inGracePeriod),
    // 유예 중이면 앱이 캐시할 유효기한은 유예 만료다(그 전에 광고를 켜면 안 된다).
    expiresAt: (inGracePeriod ? row.graceUntil : row.expiresAt)?.toISOString() ?? null,
    willRenew: row.willRenew,
    inGracePeriod,
  };
}
