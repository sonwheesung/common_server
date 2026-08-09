// SDK 라이브 가드 — client/ 가 **서버 계약과 실제로 맞는지**를 본다.
//
// 실행:  BASE_URL=https://common-server.vercel.app APP=myword node tools/_dv_sdk.ts
//
// _dv_auth.ts 는 라우트를 직접 두드리지만, 여기서는 앱이 쓰는 것과 **같은 코드**로 호출한다.
// 라우트가 멀쩡해도 SDK가 경로·필드명·헤더를 틀리면 앱에서만 깨지고 서버 가드는 전부 통과한다.
export {};

import { createCommonServer } from '../client/index.ts';
import type { SessionStorage } from '../client/types.ts';

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

/** 앱의 AsyncStorage 대역. 세션이 실제로 저장·삭제되는지 눈으로 본다. */
function memStorage(seed?: string) {
  const map = new Map<string, string>();
  if (seed) map.set(`cs_session_${APP}`, seed);
  const s: SessionStorage & { dump: () => string | null } = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    dump: () => map.get(`cs_session_${APP}`) ?? null,
  };
  return s;
}

const FORGED =
  'eyJhbGciOiJIUzI1NiJ9.eyJzaWQiOiJmYWtlIiwiYXBwIjoibXl3b3JkIiwiaWF0Ijo5OTk5OTk5OTk5OTk5fQ.ZmFrZXNpZ25hdHVyZQ';

console.log(`[_dv_sdk] ${BASE} (app=${APP})\n`);

// ── 설정 누락 ── 서버를 두드리기도 전에 걸러야 한다
{
  const none = createCommonServer({ baseUrl: '', appCode: APP, appVersion: '1.0.0', platform: 'node' });
  check('baseUrl 없음 → isConfigured false', none.isConfigured() === false);
  const r = await none.login('google', 'x');
  check('baseUrl 없음 → login not-configured', !r.ok && r.reason === 'not-configured');
}

// ── 부팅(회귀 확인) ──
{
  const sdk = createCommonServer({ baseUrl: BASE, appCode: APP, appVersion: '1.0.0', platform: 'node' });
  const r = await sdk.fetchBootstrap();
  check('fetchBootstrap 성공', r.ok, r.ok ? '' : r.reason);
}

// ── 로그인 ──
{
  const store = memStorage();
  const sdk = createCommonServer({ baseUrl: BASE, appCode: APP, appVersion: '1.0.0', platform: 'node', storage: store });

  const empty = await sdk.login('google', '');
  check('login 빈 토큰 → unauthorized(서버 안 침)', !empty.ok && empty.reason === 'unauthorized');

  const forged = await sdk.login('google', FORGED);
  check('login 위조 토큰 → unauthorized', !forged.ok && forged.reason === 'unauthorized');
  check('login 실패 시 세션 저장 안 됨', store.dump() === null, `stored=${store.dump()}`);

  // 미구현 공급자 — 타입으로도 막지만 런타임에서도 거부돼야 한다
  const kakao = await sdk.login('kakao', FORGED);
  check('login kakao 미구현 → unauthorized', !kakao.ok && kakao.reason === 'unauthorized');

  const nope = createCommonServer({ baseUrl: BASE, appCode: '__nope__', appVersion: '1.0.0', platform: 'node' });
  const gone = await nope.login('google', FORGED);
  check('login 미등록 앱 → not-found', !gone.ok && gone.reason === 'not-found');
}

// ── 세션 없는 상태 ── 서버에 물어보지 않고 즉시 not-signed-in
{
  const sdk = createCommonServer({ baseUrl: BASE, appCode: APP, appVersion: '1.0.0', platform: 'node' });
  const a = await sdk.restoreSession();
  check('restoreSession 무세션 → not-signed-in', !a.ok && a.reason === 'not-signed-in');
  const b = await sdk.fetchMyInquiries();
  check('fetchMyInquiries 무세션 → not-signed-in', !b.ok && b.reason === 'not-signed-in');
  const c = await sdk.deleteAccount();
  check('deleteAccount 무세션 → not-signed-in', !c.ok && c.reason === 'not-signed-in');
  check('isSignedIn false', (await sdk.isSignedIn()) === false);
}

// ── 저장소에 죽은 토큰이 있는 상태 ──
// 여기서 세션을 안 지우면 앱은 "로그인된 것처럼 보이는데 아무것도 안 되는" 상태에 갇힌다.
{
  const store = memStorage(FORGED);
  const sdk = createCommonServer({ baseUrl: BASE, appCode: APP, appVersion: '1.0.0', platform: 'node', storage: store });
  check('저장된 토큰을 집어옴 → isSignedIn true', (await sdk.isSignedIn()) === true);

  const r = await sdk.restoreSession();
  check('restoreSession 죽은 토큰 → unauthorized', !r.ok && r.reason === 'unauthorized');
  check('restoreSession 401이면 세션 폐기', store.dump() === null, `stored=${store.dump()}`);
}

{
  const store = memStorage(FORGED);
  const sdk = createCommonServer({ baseUrl: BASE, appCode: APP, appVersion: '1.0.0', platform: 'node', storage: store });
  const r = await sdk.fetchMyInquiries();
  check('fetchMyInquiries 죽은 토큰 → unauthorized', !r.ok && r.reason === 'unauthorized');
  check('fetchMyInquiries 401이면 세션 폐기', store.dump() === null);
}

// ── 문의 접수의 선택적 인증 ──
{
  // 세션이 없으면 익명 경로. 짧은 본문은 서버까지 가지 않고 SDK가 막는다
  const anon = createCommonServer({ baseUrl: BASE, appCode: APP, appVersion: '1.0.0', platform: 'node' });
  const short = await anon.sendInquiry('etc', 'x');
  check('sendInquiry 짧은 본문 → too-short(서버 안 침)', !short.ok && short.reason === 'too-short');

  // 죽은 세션이면 **익명으로 강등하지 않고** 실패해야 한다. 강등하면 답변받을 문의가 익명으로 새어나간다.
  const store = memStorage(FORGED);
  const sdk = createCommonServer({ baseUrl: BASE, appCode: APP, appVersion: '1.0.0', platform: 'node', storage: store });
  const r = await sdk.sendInquiry('etc', '[_dv_public] SDK 가드 — 저장되면 안 되는 문의입니다');
  check('sendInquiry 죽은 세션 → unauthorized(익명 강등 없음)', !r.ok && r.reason === 'unauthorized');
  check('sendInquiry 401이면 세션 폐기', store.dump() === null);
}

// ── 로그아웃 ──
{
  const store = memStorage(FORGED);
  const sdk = createCommonServer({ baseUrl: BASE, appCode: APP, appVersion: '1.0.0', platform: 'node', storage: store });
  await sdk.logout();
  check('logout 저장소까지 지움', store.dump() === null);
  check('logout 후 isSignedIn false', (await sdk.isSignedIn()) === false);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} — pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
