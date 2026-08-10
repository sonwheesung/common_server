// 결제 가드 — 판정·상태전이는 **DB 없이** 검증하고, 라우트는 라이브로 두드린다.
//
// 실행:  node tools/_dv_purchase.ts                                  (순수 판정만)
//        BASE_URL=https://common-server.vercel.app node tools/_dv_purchase.ts   (+ 라우트)
//
// 여기서 지키려는 불변식은 셋이다:
//   1) 도착 순서가 뒤바뀌어도 같은 상태로 수렴한다(갱신 계열 max())
//   2) 한 기간분만 환불되고 구독이 살아 있으면 다음 갱신에서 자동으로 풀린다(회수를 거래에 묶음)
//   3) 열리면 안 되는 것이 닫혀 있다(무인증·익명·미등록 키)
export {};

import {
  EMPTY_STATE,
  decideEvent,
  nextState,
  viewOf,
  type Decision,
  type EntState,
  type RcEvent,
} from '../lib/revenuecat.ts';

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

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} — pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
