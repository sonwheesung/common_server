// RevenueCat pull 폴백 — 웹훅이 유실돼도 엔타이틀먼트가 붙게 하는 두 번째 입력.
//
// **왜 필요한가.** 지금까지 엔타이틀먼트의 입력은 웹훅 하나뿐이었다. RC는 실패 시 5회(5·10·20·40·80분)
// 재시도하고 **포기한다**. 포기하면 그 사용자는 영구히 pro가 아니고, 복구 경로는 사용자가 스스로
// "구매 내역 복원"을 누르는 것뿐이다 — 돈 낸 사람이 그 버튼이 자기 문제의 답인 줄 알 리 없다.
// RC 공식 권고도 "웹훅을 받으면 GET /subscribers로 다시 당겨 동기화하라"다.
//
// ★ 설계의 요점 셋 (재발명 금지)
//
// 1) **상태 전이 규칙은 웹훅과 공유한다.** 스냅샷은 이벤트가 아니라 상태라 `decideEvent`를 못 쓴다.
//    그래서 입력 파싱만 `decideSnapshot`으로 가르고, 그 뒤 `nextState()`는 같은 것을 쓴다.
//    두 경로가 각자 상태를 계산하기 시작하면 "웹훅으로는 맞는데 pull로는 틀린" 버그가 생긴다.
//
// 2) **eventAt은 쓰는 시각이 아니라 RC에 요청을 보낸 시각(t1)이다.** 안 그러면 되감기가 난다:
//      t1 pull 발사 → t2 웹훅 도착(최신 반영) → t3 pull 응답 도착 → t1 데이터가 t2를 덮어씀
//    t1로 찍으면 `nextState`의 기존 lastEventAt 가드가 t1 ≤ t2를 보고 그냥 버린다. 새 가드가 필요 없다.
//    (RC의 event_timestamp_ms와 우리 서버 시계를 비교하는 셈이라 NTP 스큐만큼 오차가 있다.
//     스큐 구간의 웹훅이 버려질 수 있으나, 그 정보는 pull보다 오래된 것이므로 버려도 결과가 같다.)
//
// 3) **쿨다운은 Postgres에 둔다.** Upstash는 이 저장소에서 미설정이고 `checkLimit`은 fail-open이다 —
//    거기에 쿨다운을 얹으면 "미설정 = 쿨다운 없음"이라 포그라운드 복귀마다 RC를 때린다.
//    인프라가 흔들릴 때 정확히 트래픽이 터지는 방향으로 실패하는 설계다. 조건부 UPDATE는
//    쿨다운과 동시성 락을 한 문장에 담고, DB가 죽으면 라우트 자체가 못 도니 그 함정이 없다.

// 확장자를 명시한다 — 이 파일은 Next 번들과 `node tools/_dv_purchase.ts`(타입 스트리핑) 양쪽에서 로드된다.
import { sandboxGrantEnabled, type Decision } from './revenuecat.ts';

// ── 튜너블 상수(가드가 직접 읽어 드리프트 차단 — lib/ratelimit.ts의 LIMITS와 같은 이유) ──

/** 기본 쿨다운. 제한 대상은 **진짜 미구독자**다 — 구독자는 행이 생긴 뒤로 DB에서 답이 나온다. */
export const PULL_COOLDOWN_SEC = 6 * 3600;
/** `?fresh=1`(구매 직후·복원 버튼) 쿨다운. 남용해도 subject당 분당 1회라 비용이 유계다. */
export const PULL_FRESH_COOLDOWN_SEC = 60;
/**
 * pull이 **실패했을 때** 다시 열리는 시각(스탬프 시점 기준).
 * 스탬프는 claim 때 찍히므로, 롤백이 없으면 답을 못 받고도 6시간을 기다린다 —
 * 웹훅 유실 + RC 일시 장애가 겹치면 이 작업이 고치려던 상황이 다른 이유로 재현된다.
 */
export const PULL_RETRY_SEC = 120;

/**
 * 쿨다운 판정. **`pullGate.claim`의 조건부 UPDATE와 같은 규칙**을 순수하게 적은 것이다 —
 * 가드가 DB 없이 이 규칙을 검사한다. 숫자는 위 상수를 SQL이 그대로 받으므로 드리프트하지 않는다
 * (중복되는 것은 비교 연산자 하나뿐이다).
 */
export const pullAllowed = (stampedAt: Date | null, now: Date, cooldownSec: number): boolean =>
  !stampedAt || now.getTime() - stampedAt.getTime() >= cooldownSec * 1000;

/** 실패 롤백 후의 스탬프. 가장 긴 쿨다운 기준으로 PULL_RETRY_SEC 뒤에 창이 열린다. */
export const retryStamp = (now: Date): Date => new Date(now.getTime() - (PULL_COOLDOWN_SEC - PULL_RETRY_SEC) * 1000);

const RC_BASE = 'https://api.revenuecat.com/v1/subscribers';
const FETCH_TIMEOUT_MS = 5000;

/**
 * 앱별 RC secret key. 없으면 공용, 그것도 없으면 **pull 전면 no-op**(기존 동작 유지).
 * env 키 이름 규칙은 `lib/notify.ts`의 디스코드 웹훅과 같다(앱 추가 시 같은 자리를 보게).
 *
 * ⚠ 이건 진짜 시크릿이고 **그 RC 프로젝트의 모든 구독자를 읽을 수 있다.** 값을 로그·커밋에 남기지 않는다.
 * ⚠ env라서 앱을 늘릴 때 **재배포가 필요하다**(apps 테이블과 달리). 디스코드 웹훅과 같은 비대칭.
 */
export function rcSecretKey(appCode: string): string {
  const key = `RC_SECRET_API_KEY_${appCode.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  return process.env[key] || process.env.RC_SECRET_API_KEY || '';
}

// ───────────────────────── 스냅샷 모양 ─────────────────────────

/** GET /v1/subscribers 의 entitlements[key]. RC는 필드를 늘리므로 쓰는 것만 적는다. */
export interface RcSnapshotEntitlement {
  expires_date?: string | null;
  grace_period_expires_date?: string | null;
  product_identifier?: string | null;
}

/** 같은 응답의 subscriptions[product_id]. willRenew·sandbox·거래 id가 여기 있다. */
export interface RcSnapshotSubscription {
  expires_date?: string | null;
  unsubscribe_detected_at?: string | null;
  grace_period_expires_date?: string | null;
  is_sandbox?: boolean;
  store_transaction_id?: string | null;
}

export interface RcSnapshot {
  entitlements?: Record<string, RcSnapshotEntitlement> | null;
  subscriptions?: Record<string, RcSnapshotSubscription> | null;
}

/**
 * RC 호출 결과. **"구독 없음"과 "못 물어봤음"을 반드시 가른다** —
 * 200으로 "구독 없음"을 답한 것은 정상 답이다. 그걸 실패로 세면 미구독자 전원이
 * 재시도 창을 계속 열어 2분마다 RC를 때린다.
 */
export type FetchResult =
  | { status: 'ok'; snapshot: RcSnapshot } // 200 — 빈 entitlements 포함(= 정상 "구독 없음")
  | { status: 'unconfigured' } // API 키 없음 — 이 배포엔 pull이 없다
  | { status: 'failed'; reason: string }; // 네트워크·타임아웃·5xx·인증 실패

/** 주입 가능한 fetcher — 가드가 RC 호출 횟수를 세고 장애를 흉내낼 수 있어야 한다. */
export type SnapshotFetcher = (appCode: string, subjectId: string) => Promise<FetchResult>;

/** 실제 RC 호출. 던지지 않는다 — 모든 실패는 `{status:'failed'}`로 돌아온다. */
export const fetchSnapshot: SnapshotFetcher = async (appCode, subjectId) => {
  const key = rcSecretKey(appCode);
  if (!key) return { status: 'unconfigured' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${RC_BASE}/${encodeURIComponent(subjectId)}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: ctrl.signal,
      cache: 'no-store',
    });
    // 404 = "그런 구독자 없음"이라는 **확정된 답**이다. 실패로 세지 않는다.
    if (res.status === 404) return { status: 'ok', snapshot: {} };
    if (!res.ok) return { status: 'failed', reason: `http-${res.status}` };
    const body = (await res.json()) as { subscriber?: RcSnapshot };
    return { status: 'ok', snapshot: body.subscriber ?? {} };
  } catch (e) {
    return { status: 'failed', reason: e instanceof Error ? e.name : 'fetch-error' };
  } finally {
    clearTimeout(timer);
  }
};

// ───────────────────────── 순수판정 ─────────────────────────

const iso = (v: string | null | undefined): Date | null => {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t) : null;
};

const lower = (m: Record<string, unknown> | null | undefined): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m ?? {})) out[k.trim().toLowerCase()] = v;
  return out;
};

/**
 * 스냅샷 → 허용 키별 판정. **DB도 네트워크도 모른다.**
 *
 * 스냅샷은 RC의 현재 상태라 권위가 있다 → mode는 항상 `overwrite`.
 * 그래서 **키가 없으면 만료로 적는다** — 유실된 EXPIRATION("해지했는데 영원히 pro")도 이 경로가 고친다.
 *
 * `revoke`는 건드리지 않는다. 환불 회수는 거래 id에 묶여 있고(웹훅이 정한다),
 * 스냅샷에는 "어느 거래가 환불됐는지"가 없다. 환불은 만료로도 드러나므로 여기서 흉내낼 이유가 없다.
 */
export function decideSnapshot(snap: RcSnapshot, allowedKeys: string[], subjectId: string, requestedAt: Date): Decision[] {
  const ents = lower(snap.entitlements) as Record<string, RcSnapshotEntitlement | undefined>;
  const subs = lower(snap.subscriptions) as Record<string, RcSnapshotSubscription | undefined>;

  const keys = allowedKeys.map((k) => k.trim().toLowerCase()).filter(Boolean);
  return [...new Set(keys)].map((key) => {
    const ent = ents[key];
    const sub = ent?.product_identifier ? subs[ent.product_identifier.trim().toLowerCase()] : undefined;
    const environment = sub?.is_sandbox ? 'SANDBOX' : 'PRODUCTION';
    const base = {
      subjectId,
      key,
      eventAt: requestedAt, // ← 요청 발사 시각. 되감기 방지의 핵심(파일 상단 2번)
      environment,
      productId: ent?.product_identifier ?? null,
      txnId: sub?.store_transaction_id ?? null,
    };

    // 샌드박스 판정은 웹훅과 **똑같이** 다룬다. 여기만 다르면 두 경로가 갈린다.
    if (environment === 'SANDBOX' && !sandboxGrantEnabled()) {
      return { outcome: 'ignored', reason: 'sandbox', ...base } satisfies Decision;
    }

    return {
      ...base,
      outcome: 'applied',
      mode: 'overwrite', // lastEventAt 가드가 붙는다
      expiresAt: iso(ent?.expires_date),
      graceUntil: iso(ent?.grace_period_expires_date ?? sub?.grace_period_expires_date),
      // RC는 해지 예약을 unsubscribe_detected_at으로 표시한다. 없으면 자동갱신 중.
      // 엔타이틀먼트 자체가 없으면 갱신될 것도 없다(true로 두면 만료된 행이 "갱신 예정"으로 보인다).
      willRenew: Boolean(ent) && !sub?.unsubscribe_detected_at,
    } satisfies Decision;
  });
}

/**
 * 감사행의 멱등키. **결정적으로 만든다** — 같은 스냅샷을 열 번 당겨도 UNIQUE가 한 행으로 접는다.
 * 상태가 실제로 움직였을 때만 새 키가 나오므로 "왜 권한이 바뀌었나"는 남고 테이블은 안 붓는다.
 */
export function pullEventId(subjectId: string, d: Decision): string {
  const e = d.expiresAt ? d.expiresAt.getTime() : 'none';
  const g = d.graceUntil ? d.graceUntil.getTime() : 'none';
  return `pull:${subjectId}:${d.key}:${e}:${g}:${d.willRenew ? 1 : 0}`;
}

// ───────────────────────── 오케스트레이션 ─────────────────────────

/**
 * claim/release는 "쿨다운 + 락"이다. claim이 true를 준 요청만 RC를 부른다.
 * 실패 시 release가 스탬프를 뒤로 당겨 재시도 창을 연다(PULL_RETRY_SEC).
 */
export interface PullGate {
  claim(subjectId: string, cooldownSec: number): Promise<boolean>;
  release(subjectId: string): Promise<void>;
}

/** 판정 1건을 DB에 반영. 'applied'면 상태가 실제로 바뀐 것이다. */
export type PullApplier = (appCode: string, subjectId: string, d: Decision) => Promise<{ status: string }>;

export interface PullDeps {
  gate: PullGate;
  fetch: SnapshotFetcher;
  apply: PullApplier;
  now?: () => Date;
}

export type PullStatus = 'applied' | 'unchanged' | 'skipped' | 'failed';
export interface PullResult {
  status: PullStatus;
  reason?: string;
  /** 엔타이틀먼트가 실제로 바뀌었는가 — 호출부가 다시 읽을지 판단한다. */
  changed: boolean;
}

/**
 * pull 1회. **절대 던지지 않는다** — RC가 죽었다고 `/api/v1/entitlements`가 500을 주면
 * 앱은 그걸 unreachable로 보고 캐시를 유지하는데, 500이 잦으면 관측이 오염된다.
 * 실패 = 기존 DB 상태 그대로 응답.
 */
export async function runPull(
  deps: PullDeps,
  appCode: string,
  subjectId: string,
  allowedKeys: string[],
  opts: { fresh?: boolean } = {},
): Promise<PullResult> {
  const now = deps.now ?? (() => new Date());
  const cooldown = opts.fresh ? PULL_FRESH_COOLDOWN_SEC : PULL_COOLDOWN_SEC;

  try {
    // 키가 없으면 claim조차 하지 않는다 — 쿨다운을 태워봐야 영원히 할 일이 없다.
    if (!rcSecretKey(appCode)) return { status: 'skipped', reason: 'unconfigured', changed: false };
    if (!(await deps.gate.claim(subjectId, cooldown))) return { status: 'skipped', reason: 'cooldown', changed: false };

    const requestedAt = now(); // ← claim 직후, RC 왕복 **전**
    const got = await deps.fetch(appCode, subjectId);

    if (got.status === 'unconfigured') return { status: 'skipped', reason: 'unconfigured', changed: false };
    if (got.status === 'failed') {
      // "구독 없음"(200)은 여기 오지 않는다 — 정상 답이므로 쿨다운을 태운다.
      await deps.gate.release(subjectId);
      return { status: 'failed', reason: got.reason, changed: false };
    }

    let changed = false;
    for (const d of decideSnapshot(got.snapshot, allowedKeys, subjectId, requestedAt)) {
      const r = await deps.apply(appCode, subjectId, d);
      if (r.status === 'applied') changed = true;
    }
    return { status: changed ? 'applied' : 'unchanged', changed };
  } catch (e) {
    return { status: 'failed', reason: e instanceof Error ? e.name : 'error', changed: false };
  }
}
