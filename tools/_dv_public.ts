// 공개 라우트 라이브 가드 — 배포된(또는 로컬 dev) 서버를 실제로 때려 계약을 검증한다.
//
// 실행:  BASE_URL=https://xxx.vercel.app APP=myword node tools/_dv_public.ts
//        (로컬: BASE_URL=http://localhost:3100 npm run dev 띄운 상태에서)
//
// 여기서 보는 건 "정상 동작"이 아니라 **막혀야 할 게 막히는가**다 — 미등록 앱 404, 짧은 본문 400.
// 접수 성공 경로는 DB에 실제 행을 만들므로 CREATE=1 일 때만 돈다(캡을 축내지 않게).

export {}; // 모듈로 취급되게(파일 스코프 격리 + top-level await 허용)

const BASE = (process.env.BASE_URL ?? 'http://localhost:3100').replace(/\/$/, '');
const APP = process.env.APP ?? 'myword';

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

const post = (path: string, body: unknown) =>
  fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

console.log(`[_dv_public] ${BASE} (app=${APP})\n`);

// ── health ──
{
  const r = await fetch(`${BASE}/api/health`);
  const j = (await r.json()) as { ok: boolean; db: string };
  check('health 200', r.status === 200, `status=${r.status}`);
  check('health db=up', j.db === 'up', `db=${j.db}`);
}

// ── bootstrap ──
{
  const r = await fetch(`${BASE}/api/v1/bootstrap?app=${APP}`);
  check('bootstrap 200', r.status === 200, `status=${r.status}`);
  if (r.status === 200) {
    const j = (await r.json()) as { ok: boolean; maintenance: unknown; version: unknown; announcements: unknown[] };
    check('bootstrap 형태(maintenance·version·announcements)', Boolean(j.maintenance && j.version && Array.isArray(j.announcements)));
  }

  // 미등록 앱은 존재를 노출하지 않고 404
  const r2 = await fetch(`${BASE}/api/v1/bootstrap?app=__nope__`);
  check('bootstrap 미등록 앱 404', r2.status === 404, `status=${r2.status}`);

  // app 파라미터 누락도 404(400으로 흘리면 "있는 앱인지"를 탐지당한다)
  const r3 = await fetch(`${BASE}/api/v1/bootstrap`);
  check('bootstrap app 누락 404', r3.status === 404, `status=${r3.status}`);

  // 부팅은 **활성 하트비트를 겸하지만**, 토큰은 어디까지나 선택이다.
  // 무효한 토큰을 401로 잡으면 세션 만료가 **진입 게이트(점검·강제업데이트) 판정을 막는다** —
  // 서버가 점검을 앟으려는 순간 구버전 사용자가 그걸 못 받는 게 가장 나쁜 실패다.
  const r4 = await fetch(`${BASE}/api/v1/bootstrap?app=${APP}`, {
    headers: { authorization: 'Bearer not-a-real-token.deadbeef' },
  });
  check('bootstrap 무효 토큰이어도 200 (401 아님)', r4.status === 200, `status=${r4.status}`);
}

// ── tickets: 거부 경로 ──
{
  const r = await post('/api/v1/tickets', { app: '__nope__', category: 'bug', content: '테스트 문의입니다' });
  check('tickets 미등록 앱 404', r.status === 404, `status=${r.status}`);

  const r2 = await post('/api/v1/tickets', { app: APP, category: 'bug', content: '짧음' });
  check('tickets 본문 5자 미만 400', r2.status === 400, `status=${r2.status}`);
}

// ── tickets: 성공 경로(옵트인) ──
if (process.env.CREATE === '1') {
  const r = await post('/api/v1/tickets', {
    app: APP,
    category: 'etc',
    content: `[_dv_public] 가드 자동 접수 ${new Date().toISOString()}`,
    device: { platform: 'web', appVersion: '0.0.0-guard' },
  });
  const j = (await r.json()) as { ok: boolean };
  check('tickets 접수 성공', r.status === 200 && j.ok === true, `status=${r.status}`);
  // 식별자 노출 회피 — ticketId를 돌려주지 않는 계약
  check('tickets 응답에 ticketId 없음', !('ticketId' in j) && !('id' in j));
} else {
  console.log('  SKIP  tickets 접수 성공 경로 (CREATE=1 로 실행하면 실제 행을 만든다)');
}

// ── 하트비트 (2026-09-02) ────────────────────────────────────────────────────
// ⚠ bootstrap 과 **의도적으로 반대**다. bootstrap 은 무효 토큰을 조용히 무시하고 200 을 준다
//   (진입 게이트라 세션 만료가 점검·강제업데이트 판정을 막으면 안 되기 때문).
//   하트비트는 감시할 게이트가 없고 관측이 유일한 임무라, 토큰이 죽었으면 **401 로 알려줘야**
//   앱이 다음 부팅에 재등록한다(자가 치유). 이 비대칭을 여기서 못박는다.
{
  const hb = (init?: RequestInit) => fetch(`${BASE}/api/v1/heartbeat`, { method: 'POST', ...init });

  const r1 = await hb();
  check('heartbeat 토큰 없으면 401', r1.status === 401, `status=${r1.status}`);

  const r2 = await hb({ headers: { authorization: 'Bearer not-a-real-token' } });
  check('heartbeat 무효 토큰 401 (bootstrap 과 반대)', r2.status === 401, `status=${r2.status}`);

  // 서명이 우리 형식이지만 가짜인 토큰 — 파싱은 되고 검증에서 떨어져야 한다
  const forged = `${Buffer.from(JSON.stringify({ sid: '00000000-0000-4000-8000-000000000000', app: APP, iat: Date.now(), exp: Date.now() + 1000 })).toString('base64url')}.bm90LWEtcmVhbC1zaWduYXR1cmU`;
  const r3 = await hb({ headers: { authorization: `Bearer ${forged}` } });
  check('heartbeat 위조 서명 401', r3.status === 401, `status=${r3.status}`);

  // GET 은 라우트가 없다 — 관측이 쓰기라 POST 만 연다(프리페치·크롤러가 DAU 를 부풀리지 않게)
  const r4 = await fetch(`${BASE}/api/v1/heartbeat`);
  check('heartbeat GET 은 열려 있지 않다', r4.status === 405 || r4.status === 404, `status=${r4.status}`);

  // ⚠ app 파라미터를 **받지 않는다**. 인증 라우트라 앱은 토큰에서 나온다 —
  //   쿼리를 붙여도 판정이 달라지지 않아야 한다(어긋날 자리를 안 만든다).
  const r5 = await fetch(`${BASE}/api/v1/heartbeat?app=__nope__`, { method: 'POST' });
  check('heartbeat app 쿼리는 무시된다 (여전히 401)', r5.status === 401, `status=${r5.status}`);
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
// 사유: 문의 접수 성공 경로는 CREATE=1 일 때만 돈다(항상 -1)
const MIN_CHECKS = 14;
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
