// 결제 가드 — 판정·상태전이는 **DB 없이** 검증하고, 라우트는 라이브로 두드린다.
//
// 실행:  node tools/_dv_purchase.ts                                  (순수 판정만)
//        BASE_URL=https://common-server.vercel.app node tools/_dv_purchase.ts   (+ 라우트)
//
// 여기서 지키려는 불변식은 셋이다:
//   1) 도착 순서가 뒤바뀌어도 같은 상태로 수렴한다(갱신 계열 max())
//   2) 한 기간분만 환불되고 구독이 살아 있으면 다음 갱신에서 자동으로 풀린다(회수를 거래에 묶음)
//   3) 열리면 안 되는 것이 닫혀 있다(무인증·익명·미등록 키)
//   4) 웹훅이 유실돼도 pull이 건지고, RC가 죽어도 응답은 살아 있다(lib/rcPull.ts)
export {};

import {
  EMPTY_STATE,
  decideEvent,
  nextState,
  viewOf,
  type Decision,
  type EntState,
  type EntitlementView,
  type RcEvent,
} from '../lib/revenuecat.ts';
import { shouldNotifySubscription } from '../lib/notify.ts';
import {
  PULL_COOLDOWN_SEC,
  PULL_FRESH_COOLDOWN_SEC,
  PULL_EXPIRED_COOLDOWN_SEC,
  PULL_EXPIRED_WINDOW_SEC,
  PULL_RETRY_SEC,
  decideSnapshot,
  pullCooldownFor,
  pullAllowed,
  pullEventId,
  retryStamp,
  runPull,
  type FetchResult,
  type PullGate,
  type RcSnapshot,
} from '../lib/rcPull.ts';

const BASE = (process.env.BASE_URL ?? '').replace(/\/$/, '');
const KEYS = ['pro'];
const SUB = '11111111-2222-3333-4444-555555555555'; // subject_id 형식(UUID)

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const T0 = Date.parse('2026-08-01T00:00:00Z');
const DAY = 86400_000;
const at = (d: number) => T0 + d * DAY;

/** 이벤트 조립 — 기본은 정상 갱신. */
function ev(over: Partial<RcEvent> = {}): RcEvent {
  return {
    id: `evt_${Math.abs(JSON.stringify(over).length)}_${over.type ?? 'RENEWAL'}`,
    type: 'RENEWAL',
    app_user_id: SUB,
    product_id: 'jogak_pro_monthly',
    entitlement_ids: ['pro'],
    environment: 'PRODUCTION',
    event_timestamp_ms: at(0),
    expiration_at_ms: at(30),
    transaction_id: 'GPA.0001',
    ...over,
  };
}

/** 이벤트 목록을 순서대로 접어 최종 상태를 만든다. */
function fold(events: RcEvent[], now = new Date(at(1))): EntState | null {
  let s: EntState | null = null;
  for (const e of events) {
    const d: Decision = decideEvent(e, KEYS);
    if (d.outcome !== 'applied') continue;
    const n = nextState(s, d, now);
    if (n) s = n;
  }
  return s;
}

console.log('[_dv_purchase] 순수 판정\n');

// ── 판정 ──
{
  check('TEST 이벤트는 무시(연결 확인이 실패로 보이면 안 됨)', decideEvent(ev({ type: 'TEST' }), KEYS).outcome === 'ignored');

  const sandbox = decideEvent(ev({ environment: 'SANDBOX' }), KEYS);
  check('SANDBOX는 스위치 없으면 무시', sandbox.outcome === 'ignored' && sandbox.reason === 'sandbox');

  for (const bad of ['$RCAnonymousID:abc', 'not-a-uuid', '']) {
    const d = decideEvent(ev({ app_user_id: bad }), KEYS);
    check(`익명/비-UUID app_user_id 거부 (${bad || '빈값'})`, d.outcome === 'rejected' && d.reason === 'anonymous-app-user-id');
  }

  // RC에서 상품을 엔타이틀먼트에 attach하지 않으면 여기가 빈다 — "결제는 됐는데 광고가 나온다"의 대표 원인
  const noEnt = decideEvent(ev({ entitlement_ids: [] }), KEYS);
  check('entitlement_ids 빈 배열은 사유를 구분해 거부', noEnt.outcome === 'rejected' && noEnt.reason === 'no-entitlement-ids');

  const wrong = decideEvent(ev({ entitlement_ids: ['Pro_Plus'] }), KEYS);
  check('허용 목록에 없는 키 거부', wrong.outcome === 'rejected' && String(wrong.reason).startsWith('unknown-key'));

  check('대소문자 무관하게 키 매칭', decideEvent(ev({ entitlement_ids: ['PRO'] }), KEYS).key === 'pro');

  const cancel = decideEvent(ev({ type: 'CANCELLATION' }), KEYS);
  check('CANCELLATION은 만료를 안 건드리고 willRenew만 끔', cancel.mode === 'none' && cancel.willRenew === false);

  check('REFUND는 회수 표시', decideEvent(ev({ type: 'REFUND' }), KEYS).revoke === true);
  check('PRODUCT_CHANGE는 덮어쓰기', decideEvent(ev({ type: 'PRODUCT_CHANGE' }), KEYS).mode === 'overwrite');
  check('EXPIRATION은 덮어쓰기', decideEvent(ev({ type: 'EXPIRATION' }), KEYS).mode === 'overwrite');
  check('RENEWAL은 max()', decideEvent(ev({ type: 'RENEWAL' }), KEYS).mode === 'extend');
  check('모르는 타입은 무시(재시도 폭풍 방지)', decideEvent(ev({ type: 'SOMETHING_NEW' }), KEYS).outcome === 'ignored');
}

console.log('\n[_dv_purchase] 상태 전이\n');

// ── 1. 순서역전 수렴 ── 이 설계의 핵심 주장
{
  const initial = ev({ type: 'INITIAL_PURCHASE', event_timestamp_ms: at(0), expiration_at_ms: at(30), transaction_id: 'T1' });
  const renewal = ev({ type: 'RENEWAL', event_timestamp_ms: at(30), expiration_at_ms: at(60), transaction_id: 'T2' });

  const fwd = fold([initial, renewal]);
  const rev = fold([renewal, initial]);
  check(
    '갱신 계열은 도착 순서와 무관하게 같은 만료로 수렴',
    fwd?.expiresAt?.getTime() === at(60) && rev?.expiresAt?.getTime() === at(60),
    `fwd=${fwd?.expiresAt?.toISOString()} rev=${rev?.expiresAt?.toISOString()}`,
  );

  // EXPIRATION이 RENEWAL보다 늦게 도착 — 과거 이벤트가 현재를 덮으면 안 된다
  const expire = ev({ type: 'EXPIRATION', event_timestamp_ms: at(29), expiration_at_ms: at(29), transaction_id: 'T1' });
  const late = fold([initial, renewal, expire]);
  check('늦게 온 과거 EXPIRATION은 무시', late?.expiresAt?.getTime() === at(60), `${late?.expiresAt?.toISOString()}`);

  // 정상 순서의 EXPIRATION은 먹어야 한다
  const proper = ev({ type: 'EXPIRATION', event_timestamp_ms: at(61), expiration_at_ms: at(60), transaction_id: 'T2' });
  const ended = fold([initial, renewal, proper]);
  check('제때 온 EXPIRATION은 만료를 확정', ended?.expiresAt?.getTime() === at(60));
  check('만료 후 비활성', viewOf(ended!, new Date(at(61))).active === false);
}

// ── 2. PRODUCT_CHANGE가 만료를 앞당기는 경우 ── max()면 과다 지급이 된다
{
  const yearly = ev({ type: 'INITIAL_PURCHASE', event_timestamp_ms: at(0), expiration_at_ms: at(365), transaction_id: 'T1' });
  const toMonthly = ev({
    type: 'PRODUCT_CHANGE',
    event_timestamp_ms: at(10),
    expiration_at_ms: at(40),
    product_id: 'jogak_pro_monthly',
    transaction_id: 'T2',
  });
  const s = fold([yearly, toMonthly]);
  check('연간→월간 전환은 만료를 앞당긴다(max()가 아니다)', s?.expiresAt?.getTime() === at(40), `${s?.expiresAt?.toISOString()}`);

  // 그 덮어쓰기가 순서를 타므로 가드가 필요하다
  const stale = ev({ type: 'PRODUCT_CHANGE', event_timestamp_ms: at(5), expiration_at_ms: at(999), transaction_id: 'T0' });
  const guarded = fold([yearly, toMonthly, stale]);
  check('늦게 온 과거 PRODUCT_CHANGE는 무시', guarded?.expiresAt?.getTime() === at(40));
}

// ── 3. 환불 후 갱신 ── "돈은 내는데 pro가 아닌" 상태를 만들지 않는가
{
  const initial = ev({ type: 'INITIAL_PURCHASE', event_timestamp_ms: at(0), expiration_at_ms: at(30), transaction_id: 'T1' });
  const refund = ev({ type: 'REFUND', event_timestamp_ms: at(5), transaction_id: 'T1' });

  const revoked = fold([initial, refund]);
  check('이번 기간분 환불 → 즉시 비활성', viewOf(revoked!, new Date(at(6))).active === false);

  // 구독이 살아 있어 다음 갱신이 온다 — 새 거래이므로 회수가 자동으로 풀려야 한다
  const renewal = ev({ type: 'RENEWAL', event_timestamp_ms: at(30), expiration_at_ms: at(60), transaction_id: 'T2' });
  const healed = fold([initial, refund, renewal]);
  check(
    '환불 후 갱신(새 거래) → 자동으로 다시 활성',
    viewOf(healed!, new Date(at(31))).active === true,
    `revoked=${healed?.revokedTxnId} last=${healed?.lastTxnId}`,
  );

  // 환불이 구독을 끝낸 경우는 만료가 과거로 가서 어차피 비활성
  const expire = ev({ type: 'EXPIRATION', event_timestamp_ms: at(6), expiration_at_ms: at(5), transaction_id: 'T1' });
  const dead = fold([initial, refund, expire]);
  check('환불이 구독을 끝냈으면 만료로도 비활성', viewOf(dead!, new Date(at(7))).active === false);
}

// ── 4. 해지 예약 · 결제 실패 유예 ──
{
  const initial = ev({ type: 'INITIAL_PURCHASE', event_timestamp_ms: at(0), expiration_at_ms: at(30), transaction_id: 'T1' });
  const cancel = ev({ type: 'CANCELLATION', event_timestamp_ms: at(5), transaction_id: 'T1' });
  const s = fold([initial, cancel]);
  check('해지 예약해도 만료까지는 활성', viewOf(s!, new Date(at(10))).active === true);
  check('해지 예약은 willRenew=false로 드러난다', s?.willRenew === false);
  check('해지한 구독도 만료 후엔 비활성', viewOf(s!, new Date(at(31))).active === false);

  // 카드 갱신 중인 사람의 백업을 멈추지 않는다
  const billing = ev({
    type: 'BILLING_ISSUE',
    event_timestamp_ms: at(30),
    grace_period_expiration_at_ms: at(37),
    transaction_id: 'T1',
  });
  const grace = fold([initial, billing]);
  const v = viewOf(grace!, new Date(at(32)));
  check('결제 실패 유예 중 활성 유지', v.active === true && v.inGracePeriod === true);
  check('유예 중 만료시각은 유예 종료로 보인다(앱이 그 전에 광고를 켜면 안 된다)', v.expiresAt === new Date(at(37)).toISOString());
  check('유예도 끝나면 비활성', viewOf(grace!, new Date(at(38))).active === false);

  // 갱신되면 유예가 풀려야 한다
  const recovered = fold([initial, billing, ev({ type: 'RENEWAL', event_timestamp_ms: at(33), expiration_at_ms: at(60), transaction_id: 'T2' })]);
  check('갱신 성공 시 유예 해제', recovered?.graceUntil === null);
}

// ── 5. 미구독자 ──
{
  check('상태 없음 = 비활성', viewOf(EMPTY_STATE).active === false);
}

// ── 6. pull 폴백 ── 웹훅이 유일한 입력이던 구멍을 메우는 경로(lib/rcPull.ts)
//
// I/O(RC 호출·쿨다운 스탬프)를 전부 주입해 **DB 없이** 검사한다.
// 조각의 교훈은 "순수 계층이 문제"가 아니라 **I/O 경계가 순수하지 않았던 것**이 문제라는 쪽이다.
{
  const PULL_APP = 'jogak';
  const clock = { now: new Date(at(1)) };

  /** subjects.rc_pulled_at 을 메모리로 흉내낸다. 규칙은 pullAllowed/retryStamp를 그대로 쓴다. */
  function memGate(): PullGate & { stamps: Map<string, Date> } {
    const stamps = new Map<string, Date>();
    return {
      stamps,
      async claim(subjectId: string, cooldownSec: number) {
        if (!pullAllowed(stamps.get(subjectId) ?? null, clock.now, cooldownSec)) return false;
        stamps.set(subjectId, clock.now);
        return true;
      },
      async release(subjectId: string) {
        stamps.set(subjectId, retryStamp(clock.now));
      },
    };
  }

  /** applyPull의 순수 대역 — nextState로 접어 상태를 만든다(트랜잭션·감사행은 DB의 몫). */
  function memApply(store: { state: EntState | null }) {
    return async (_app: string, _sub: string, d: Decision) => {
      if (d.outcome !== 'applied') return { status: 'ignored' };
      const n = nextState(store.state, d, clock.now);
      if (!n) return { status: 'ignored' };
      store.state = n;
      return { status: 'applied' };
    };
  }

  const activeSnap = (over: Partial<RcSnapshot> = {}): RcSnapshot => ({
    entitlements: { pro: { expires_date: new Date(at(30)).toISOString(), product_identifier: 'jogak_pro_monthly' } },
    subscriptions: { jogak_pro_monthly: { expires_date: new Date(at(30)).toISOString(), store_transaction_id: 'GPA.9999' } },
    ...over,
  });

  const okFetch = (snap: RcSnapshot) => {
    let calls = 0;
    const fn = async (): Promise<FetchResult> => {
      calls++;
      return { status: 'ok', snapshot: snap };
    };
    return Object.assign(fn, { count: () => calls });
  };

  process.env.RC_SECRET_API_KEY = 'guard-fake-key-not-a-real-secret';

  // (1) 웹훅이 **한 번도 안 온** subject — pull이 권한을 붙인다. 이 작업의 존재 이유다.
  {
    const store = { state: null as EntState | null };
    const gate = memGate();
    const fetchFn = okFetch(activeSnap());
    const r = await runPull({ gate, fetch: fetchFn, apply: memApply(store) }, PULL_APP, SUB, KEYS);
    check(
      '웹훅 미도래 subject도 pull이 pro를 붙인다',
      r.status === 'applied' && !!store.state && viewOf(store.state, clock.now).active,
    );
  }

  // (2) 쿨다운 — RC 호출 횟수를 직접 센다
  {
    const store = { state: null as EntState | null };
    const gate = memGate();
    const fetchFn = okFetch(activeSnap());
    const deps = { gate, fetch: fetchFn, apply: memApply(store) };
    await runPull(deps, PULL_APP, SUB, KEYS);
    const second = await runPull(deps, PULL_APP, SUB, KEYS);
    check('쿨다운 안에서는 RC를 부르지 않는다', fetchFn.count() === 1 && second.reason === 'cooldown', `calls=${fetchFn.count()}`);

    clock.now = new Date(clock.now.getTime() + PULL_COOLDOWN_SEC * 1000);
    await runPull(deps, PULL_APP, SUB, KEYS);
    check('쿨다운이 지나면 다시 부른다', fetchFn.count() === 2, `calls=${fetchFn.count()}`);
    clock.now = new Date(at(1));
  }

  // (3) fresh는 짧은 쿨다운을 쓴다 — 결제 직후 8회 백오프가 pull 2~3회로 수렴해야 한다
  {
    const store = { state: null as EntState | null };
    const gate = memGate();
    const fetchFn = okFetch(activeSnap());
    const deps = { gate, fetch: fetchFn, apply: memApply(store) };
    await runPull(deps, PULL_APP, SUB, KEYS, { fresh: true });
    clock.now = new Date(clock.now.getTime() + PULL_FRESH_COOLDOWN_SEC * 1000);
    await runPull(deps, PULL_APP, SUB, KEYS, { fresh: true });
    const blocked = await runPull(deps, PULL_APP, SUB, KEYS); // 같은 시각의 일반 경로는 여전히 잠겨 있다
    check(
      'fresh는 60초 쿨다운, 일반 경로는 그대로 잠긴다',
      fetchFn.count() === 2 && blocked.reason === 'cooldown',
      `calls=${fetchFn.count()}`,
    );
    clock.now = new Date(at(1));
  }

  // (4) RC 장애 — 기존 상태를 건드리지 않고, 호출부가 500을 만들 재료를 주지 않는다
  {
    const before = nextState(null, decideEvent(ev(), KEYS), clock.now)!;
    const store = { state: before as EntState | null };
    const gate = memGate();
    const r = await runPull(
      { gate, fetch: async () => ({ status: 'failed', reason: 'http-503' }), apply: memApply(store) },
      PULL_APP,
      SUB,
      KEYS,
    );
    check('RC 장애 시 실패를 알리되 던지지 않는다', r.status === 'failed' && r.changed === false);
    check('RC 장애 시 기존 엔타이틀먼트가 그대로다', store.state === before);
  }

  // (5) pull 실패 후 **재시도 창이 열린다** — 롤백이 없으면 답을 못 받고도 6시간 잠긴다
  {
    const store = { state: null as EntState | null };
    const gate = memGate();
    let calls = 0;
    const flaky = async (): Promise<FetchResult> => {
      calls++;
      return calls === 1 ? { status: 'failed', reason: 'AbortError' } : { status: 'ok', snapshot: activeSnap() };
    };
    const deps = { gate, fetch: flaky, apply: memApply(store) };
    await runPull(deps, PULL_APP, SUB, KEYS);

    clock.now = new Date(clock.now.getTime() + (PULL_RETRY_SEC - 1) * 1000);
    const tooEarly = await runPull(deps, PULL_APP, SUB, KEYS);
    check('실패 직후 재시도 창이 열리기 전엔 잠겨 있다', tooEarly.reason === 'cooldown' && calls === 1);

    clock.now = new Date(clock.now.getTime() + 2000);
    const retried = await runPull(deps, PULL_APP, SUB, KEYS);
    check('실패 후 PULL_RETRY_SEC 뒤에 재시도가 열린다', retried.status === 'applied' && calls === 2, `calls=${calls}`);
    clock.now = new Date(at(1));
  }

  // (6) 200 "구독 없음"은 **실패가 아니다** — 실패로 세면 미구독자 전원이 2분마다 RC를 때린다
  {
    const store = { state: null as EntState | null };
    const gate = memGate();
    const fetchFn = okFetch({});
    const deps = { gate, fetch: fetchFn, apply: memApply(store) };
    await runPull(deps, PULL_APP, SUB, KEYS);
    clock.now = new Date(clock.now.getTime() + PULL_RETRY_SEC * 1000 + 1000);
    await runPull(deps, PULL_APP, SUB, KEYS);
    check('200 "구독 없음"은 쿨다운을 태운다(재시도 창을 열지 않는다)', fetchFn.count() === 1, `calls=${fetchFn.count()}`);
    clock.now = new Date(at(1));
  }

  // (7) pull과 웹훅이 **동시에** 도착해도 같은 곳으로 수렴한다
  {
    const t1 = new Date(at(1)); // pull 발사 시각
    const wh = ev({ type: 'RENEWAL', event_timestamp_ms: at(2), expiration_at_ms: at(60) }); // 더 새 정보
    const pull = decideSnapshot(activeSnap(), KEYS, SUB, t1)[0]; // t1 시점 정보(만료 at(30))
    const whD = decideEvent(wh, KEYS);

    const a = nextState(nextState(null, pull, clock.now), whD, clock.now)!; // pull → 웹훅
    const b = nextState(nextState(null, whD, clock.now), pull, clock.now); // 웹훅 → pull(늦게 반영)
    check(
      'pull·웹훅 동시 도착 — 순서를 바꿔도 같은 만료로 수렴',
      a.expiresAt?.getTime() === at(60) && (b === null || b.expiresAt?.getTime() === at(60)),
      `a=${a.expiresAt?.toISOString()} b=${b?.expiresAt?.toISOString() ?? 'null'}`,
    );
    check('늦게 반영된 pull이 최신 웹훅을 되감지 않는다', b === null || b.expiresAt!.getTime() >= at(60));
  }

  // (8) 유실된 EXPIRATION 복구 — 스냅샷에 키가 없으면 만료로 적는다("해지했는데 영원히 pro")
  {
    const alive = nextState(null, decideEvent(ev({ expiration_at_ms: at(60) }), KEYS), clock.now)!;
    const d = decideSnapshot({}, KEYS, SUB, new Date(at(5)))[0];
    const after = nextState(alive, d, new Date(at(5)))!;
    check('스냅샷에 키가 없으면 만료로 내려온다(유실 EXPIRATION 복구)', !viewOf(after, new Date(at(5))).active);
  }

  // (9) SANDBOX 판정이 웹훅과 같다 — 여기만 다르면 두 경로가 갈린다
  {
    const snap = activeSnap({
      subscriptions: { jogak_pro_monthly: { is_sandbox: true, expires_date: new Date(at(30)).toISOString() } },
    });
    const d = decideSnapshot(snap, KEYS, SUB, clock.now)[0];
    check('pull도 SANDBOX는 스위치 없으면 무시', d.outcome === 'ignored' && d.reason === 'sandbox');
  }

  // (10) 감사행 멱등키가 결정적이다 — 같은 스냅샷을 반복 pull해도 행이 안 쌓인다
  {
    const a = pullEventId(SUB, decideSnapshot(activeSnap(), KEYS, SUB, new Date(at(1)))[0]);
    const b = pullEventId(SUB, decideSnapshot(activeSnap(), KEYS, SUB, new Date(at(3)))[0]);
    const c = pullEventId(SUB, decideSnapshot({}, KEYS, SUB, new Date(at(1)))[0]);
    check('같은 스냅샷 = 같은 멱등키(요청 시각이 달라도)', a === b);
    check('상태가 다르면 다른 멱등키', a !== c);
  }

  // (11) 키가 없는 배포는 쿨다운조차 태우지 않는다 — 나중에 키를 넣으면 즉시 동작해야 한다
  {
    delete process.env.RC_SECRET_API_KEY;
    const gate = memGate();
    const fetchFn = okFetch(activeSnap());
    const r = await runPull({ gate, fetch: fetchFn, apply: memApply({ state: null }) }, PULL_APP, SUB, KEYS);
    check(
      'RC 키 없으면 no-op(쿨다운 스탬프도 안 찍는다)',
      r.reason === 'unconfigured' && gate.stamps.size === 0 && fetchFn.count() === 0,
    );
  }
}

// ── 7. 만료 직후의 쿨다운 ── 2026-08-19 실결제 검증에서 드러난 창
//
// 실측 순서: 14:06:21 결제 → RC가 **90초짜리 만료**를 준다(Play가 확정하기 전) →
// 14:07:51 만료 → **14:24:19에야 RENEWAL로 한 달이 온다.** 그 17분 동안 결제자는 미구독자였고,
// 직전 pull이 찍은 6시간 스탬프가 재확인을 막고 있었다. RENEWAL이 유실됐다면 6시간이었다.
{
  const now = new Date(at(1));
  const view = (over: Partial<EntitlementView>): EntitlementView => ({
    active: false,
    expiresAt: new Date(now.getTime() - 60_000).toISOString(),
    willRenew: true,
    inGracePeriod: false,
    ...over,
  });

  check('갱신 예정인데 만료됨 → 짧은 쿨다운', pullCooldownFor([view({})], now) === PULL_EXPIRED_COOLDOWN_SEC);
  check('한 번도 구독 안 함 → 기본 쿨다운', pullCooldownFor([], now) === PULL_COOLDOWN_SEC);
  check('해지하고 만료됨 → 기본 쿨다운(답이 바뀔 일이 없다)', pullCooldownFor([view({ willRenew: false })], now) === PULL_COOLDOWN_SEC);

  // 이탈한 옛 구독자가 앱을 열 때마다 10분마다 RC를 때리면 안 된다
  const churned = view({ expiresAt: new Date(now.getTime() - (PULL_EXPIRED_WINDOW_SEC + 60) * 1000).toISOString() });
  check('오래 전에 만료된 구독자는 창 밖 → 기본 쿨다운', pullCooldownFor([churned], now) === PULL_COOLDOWN_SEC);

  // 실측 재현: 90초 만료가 지난 직후, 6시간이 아니라 10분 뒤에 다시 물어본다
  {
    const clock = { now: new Date(at(1)) };
    const stamps = new Map<string, Date>();
    const gate = {
      async claim(id: string, cooldownSec: number) {
        if (!pullAllowed(stamps.get(id) ?? null, clock.now, cooldownSec)) return false;
        stamps.set(id, clock.now);
        return true;
      },
      async release(id: string) {
        stamps.set(id, retryStamp(clock.now));
      },
    };
    let calls = 0;
    const fetchFn = async (): Promise<FetchResult> => {
      calls++;
      return { status: 'ok', snapshot: {} };
    };
    const deps = { gate, fetch: fetchFn, apply: async () => ({ status: 'ignored' }), now: () => clock.now };
    process.env.RC_SECRET_API_KEY = 'guard-fake-key-not-a-real-secret';

    const lapsed = pullCooldownFor([view({})], clock.now);
    await runPull(deps, 'jogak', SUB, KEYS, { cooldownSec: lapsed });
    clock.now = new Date(clock.now.getTime() + PULL_EXPIRED_COOLDOWN_SEC * 1000);
    await runPull(deps, 'jogak', SUB, KEYS, { cooldownSec: lapsed });
    check('만료 직후엔 6시간이 아니라 10분 뒤에 재확인한다', calls === 2, `calls=${calls}`);
    delete process.env.RC_SECRET_API_KEY;
  }

  // 짧은 만료가 **정상 값일 수 있다**는 것 — 최소 주기 가드를 걸면 안 되는 이유
  {
    const short = decideEvent(
      ev({ type: 'INITIAL_PURCHASE', purchased_at_ms: at(0), event_timestamp_ms: at(0), expiration_at_ms: at(0) + 90_000 }),
      KEYS,
    );
    const s1 = nextState(null, short, new Date(at(0) + 1000))!;
    check('90초짜리 만료도 그대로 받는다(Play 결제 확정 대기 구간의 실제 값)', s1.expiresAt?.getTime() === at(0) + 90_000);

    // 그리고 확정 후 RENEWAL이 한 달로 밀어준다 — max()라 순서를 안 탄다
    const renew = decideEvent(ev({ type: 'RENEWAL', event_timestamp_ms: at(0) + 90_000, expiration_at_ms: at(30) }), KEYS);
    const s2 = nextState(s1, renew, new Date(at(0) + 91_000))!;
    check('확정 RENEWAL이 만료를 한 달로 정정한다', s2.expiresAt?.getTime() === at(30) && viewOf(s2, new Date(at(1))).active);
  }
}

// ── 8. 구독 알림 대상 판정 (2026-09-09) ──
// 🔴 이 판정이 틀리면 **두 방향으로 아프다**: 넓으면 샌드박스 테스트마다 채널이 시끄러워지고,
//   좁으면 해지를 모른 채 지나간다. 그래서 **보낼 것과 안 보낼 것을 둘 다 잰다**
//   (한쪽만 재면 반대쪽이 무너진다 — 2026-09-08에 배운 것).
{
  console.log('\n[_dv_purchase] 구독 알림 대상\n');
  for (const t of ['INITIAL_PURCHASE', 'CANCELLATION', 'EXPIRATION', 'REFUND']) {
    check(`알린다: ${t}`, shouldNotifySubscription(t));
  }
  // 🚫 빼기로 한 것들. RENEWAL 은 사용자가 요청하지 않았고, PULL 은 우리가 스스로 당긴 동기화다.
  for (const t of ['RENEWAL', 'PULL', 'BILLING_ISSUE', 'PRODUCT_CHANGE', 'TRANSFER', 'UNCANCELLATION']) {
    check(`안 알린다: ${t}`, !shouldNotifySubscription(t));
  }
  check('소문자로 와도 판정한다', shouldNotifySubscription('initial_purchase'));
  check('빈 타입은 안 알린다', !shouldNotifySubscription(''));
}

// ── 라우트(선택) ──
if (BASE) {
  console.log('\n[_dv_purchase] 라우트 — ' + BASE + '\n');
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  const r1 = await post('/api/webhooks/revenuecat/jogak', { event: ev() });
  check('웹훅 무인증 401', r1.status === 401, `status=${r1.status}`);

  const r2 = await post('/api/webhooks/revenuecat/jogak', { event: ev() }, { authorization: 'Bearer wrong-secret-value-that-is-long-enough' });
  check('웹훅 틀린 시크릿 401', r2.status === 401, `status=${r2.status}`);

  const r3 = await post('/api/webhooks/revenuecat/__nope__', { event: ev() }, { authorization: 'x' });
  check('웹훅 미등록 앱 404', r3.status === 404, `status=${r3.status}`);

  const r4 = await fetch(`${BASE}/api/v1/entitlements`);
  check('entitlements 무토큰 401', r4.status === 401, `status=${r4.status}`);

  const r5 = await fetch(`${BASE}/api/v1/entitlements`, { headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.ZmFrZQ.ZmFrZQ' } });
  check('entitlements 위조 토큰 401', r5.status === 401, `status=${r5.status}`);

  const r6 = await fetch(`${BASE}/api/admin/billing?app=jogak`);
  check('admin/billing 무인증 401', r6.status === 401, `status=${r6.status}`);
}

// ── 🔴 가드가 **줄어든 것**을 잡는다 (2026-09-02) ────────────────────────────
// my_word 세션 실측: jest 스위트 9개 중 7개가 로드조차 안 되고 있었는데, 죽은 스위트의
// 테스트는 **실패가 아니라 세어지지도 않는다**. 그래서 `26 passed, 26 total`(=전부 통과)로
// 보였고, 140개였던 것이 26개로 줄어든 것을 아무도 대조하지 않았다 —
// **그 상태로 1.3.3이 프로덕션에 나갔다.**
//
// 여기도 같은 함정이 있다: 섹션이 조건부로 스킵되면(`if (TOKEN)`·`SKIP` 분기) 개수만 줄고
// 마지막 줄은 여전히 `ALL PASS`다. 통과 개수를 사람이 매번 기억할 수는 없으므로 **바닥을 박아둔다.**
//
// ⚠ 검사를 늘렸으면 이 숫자도 같이 올린다. 귀찮은 게 요점이다 —
//   안 올리면 다음에 섹션이 하나 죽어도 바닥에 안 걸린다.
// 사유: RC 키가 env 에 있으면 오히려 늘어난다(+5)
const MIN_CHECKS = 66;   // 2026-09-09 구독 알림 대상 판정 12개 추가 (54 → 66). REFUND 를 안알림→알림으로 옮겨 개수는 그대로
{
  const ran = pass + fail;
  if (ran < MIN_CHECKS) {
    fail++;
    console.log(
      `  FAIL  가드가 줄었다 — ${ran}개만 돌았다(최소 ${MIN_CHECKS}). 섹션이 스킵됐거나 로드에 실패했다`,
    );
  }
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} — pass=${pass} fail=${fail} (실행 ${pass + fail} / 최소 ${MIN_CHECKS})`);
process.exit(fail === 0 ? 0 : 1);
