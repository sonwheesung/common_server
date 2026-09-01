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

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} — pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
