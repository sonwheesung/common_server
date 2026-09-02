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

// 공급자(구글) ID 토큰 위조본 — login()에 넘겨 "서버가 어떤 값도 통과시키지 않는가"를 본다.
// ⚠ 우리 세션 토큰이 아니다(3-세그먼트 JWT 모양). 세션 자리에 쓰지 말 것 — 아래 DEAD_SESSION을 쓴다.
const FORGED =
  'eyJhbGciOiJIUzI1NiJ9.eyJzaWQiOiJmYWtlIiwiYXBwIjoibXl3b3JkIiwiaWF0Ijo5OTk5OTk5OTk5OTk5fQ.ZmFrZXNpZ25hdHVyZQ';

/**
 * 저장소에 남아 있는 **죽은 세션 토큰**. 우리 형식(`body.sig`)이고 iat도 최신이라
 * 앱은 "로그인 돼 있다"고 믿지만, 서명이 가짜라 서버는 401을 준다.
 *
 * 만료된 토큰이 아니라 이걸 쓰는 이유: 만료는 `isSignedIn()`이 먼저 걸러내므로
 * 서버까지 못 간다. 여기서 보려는 건 **서버가 거부했을 때 세션을 폐기하는가**라서,
 * 로컬 판정을 통과하는 토큰이어야 그 경로가 실제로 탄다.
 */
const DEAD_SESSION = `${Buffer.from(JSON.stringify({ sid: 'fake', app: APP, iat: Date.now() })).toString(
  'base64url',
)}.bm90LWEtcmVhbC1zaWduYXR1cmU`;

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
  const store = memStorage(DEAD_SESSION);
  const sdk = createCommonServer({ baseUrl: BASE, appCode: APP, appVersion: '1.0.0', platform: 'node', storage: store });
  check('저장된 토큰을 집어옴 → isSignedIn true', (await sdk.isSignedIn()) === true);

  const r = await sdk.restoreSession();
  check('restoreSession 죽은 토큰 → unauthorized', !r.ok && r.reason === 'unauthorized');
  check('restoreSession 401이면 세션 폐기', store.dump() === null, `stored=${store.dump()}`);
}

{
  const store = memStorage(DEAD_SESSION);
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
  const store = memStorage(DEAD_SESSION);
  const sdk = createCommonServer({ baseUrl: BASE, appCode: APP, appVersion: '1.0.0', platform: 'node', storage: store });
  const r = await sdk.sendInquiry('etc', '[_dv_public] SDK 가드 — 저장되면 안 되는 문의입니다');
  check('sendInquiry 죽은 세션 → unauthorized(익명 강등 없음)', !r.ok && r.reason === 'unauthorized');
  check('sendInquiry 401이면 세션 폐기', store.dump() === null);
}

// ── 로그아웃 ──
{
  const store = memStorage(DEAD_SESSION);
  const sdk = createCommonServer({ baseUrl: BASE, appCode: APP, appVersion: '1.0.0', platform: 'node', storage: store });
  await sdk.logout();
  check('logout 저장소까지 지움', store.dump() === null);
  check('logout 후 isSignedIn false', (await sdk.isSignedIn()) === false);
}

// ── isSignedIn이 만료를 본다 (2026-09-01) ───────────────────────────────────
// 종전엔 "저장소에 문자열이 있나"만 봤다. 그래서 만료 토큰을 들고도 true를 줬고,
// 이걸 가드로 쓰는 앱의 ensureDeviceSession()이 재등록을 영원히 건너뛰어
// 그 기기가 활성 집계에서 조용히 사라졌다. 서명은 안 본다 — 만료만 본다.
{
  const b64u = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const tok = (iat: number) => `${b64u({ sid: 'x', app: APP, iat })}.sig`;
  const DAY = 86_400_000;

  const mem = (v: string | null) => {
    let cur = v;
    return {
      getItem: async () => cur,
      setItem: async (_k: string, val: string) => {
        cur = val;
      },
      removeItem: async () => {
        cur = null;
      },
    };
  };
  const mk = (v: string | null) =>
    createCommonServer({ baseUrl: BASE, appCode: APP, appVersion: '1.0.0', platform: 'node', storage: mem(v) });

  check('isSignedIn: 저장소가 비면 false', (await mk(null).isSignedIn()) === false);
  check('isSignedIn: 방금 발급한 토큰은 true', (await mk(tok(Date.now())).isSignedIn()) === true);
  check('isSignedIn: 179일 된 토큰은 아직 true', (await mk(tok(Date.now() - 179 * DAY)).isSignedIn()) === true);
  check('isSignedIn: 181일 된 토큰은 false', (await mk(tok(Date.now() - 181 * DAY)).isSignedIn()) === false);
  // 깨진 토큰은 살아있다고 보면 안 된다 — 재등록이 영원히 안 일어나는 그 공백이 그대로 재현된다.
  check('isSignedIn: 형식이 깨진 토큰은 false', (await mk('garbage-no-dot').isSignedIn()) === false);
  check('isSignedIn: iat 없는 토큰은 false', (await mk(`${b64u({ sid: 'x', app: APP })}.sig`).isSignedIn()) === false);
}

// ── 하트비트: 🔴 **절대 reject 하지 않는다** (2026-09-02) ────────────────────
// 이 절이 이 기능의 계약을 지키는 유일한 장치다. 문서 약속만으로 두면 다음 리팩터에
// `Result`를 돌려주거나 throw가 새는 쪽으로 조용히 되돌아간다.
//
// 왜 이렇게까지 하나: 호출부가 `AppState` 리스너다.
//   AppState.addEventListener('change', (st) => { if (st === 'active') server.heartbeat(); });
// 리스너 콜백은 동기라 `.catch()`를 걸 곳이 없고, 여기서 새어 나간 rejection은
// ErrorBoundary/ErrorUtils를 둔 앱에서 **그대로 오류 UI가 된다**.
{
  /** reject 여부만 본다. 반환값은 원래 없다(void) — 성공/실패를 알려주지 않는 게 계약이다. */
  const rejects = async (fn: () => Promise<void>): Promise<boolean> => {
    try {
      const r = await fn();
      return r !== undefined; // void 가 아니면 계약 위반(반환값이 생겼다)
    } catch {
      return true;
    }
  };

  // ① 서버가 아예 없는 주소 — 연결 거부. 가장 흔한 실패(지하철·비행기 모드)의 대역이다.
  const dead = createCommonServer({
    baseUrl: 'http://127.0.0.1:9', // discard 포트 — 항상 연결 거부
    appCode: APP,
    appVersion: '1.0.0',
    platform: 'node',
    storage: memStorage(DEAD_SESSION),
  });
  check('heartbeat: 서버가 죽어 있어도 reject 안 함', (await rejects(() => dead.heartbeat())) === false);

  // ② baseUrl 미설정 — 요청 자체가 안 나간다
  const unset = createCommonServer({ baseUrl: '', appCode: APP, appVersion: '1.0.0', platform: 'node' });
  check('heartbeat: baseUrl 없어도 reject 안 함', (await rejects(() => unset.heartbeat())) === false);

  // ③ 세션이 없을 때 — 다른 메서드는 'not-signed-in'을 돌려주지만 여긴 반환값이 없다.
  //    조용히 넘어가야 하고, **요청조차 나가면 안 된다**(무의미한 401을 서버에 쌓는다).
  {
    let calls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (...a: Parameters<typeof fetch>) => {
      calls++;
      return realFetch(...a);
    }) as typeof fetch;
    const noSess = createCommonServer({ baseUrl: BASE, appCode: APP, appVersion: '1.0.0', platform: 'node' });
    const threw = await rejects(() => noSess.heartbeat());
    globalThis.fetch = realFetch;
    check('heartbeat: 세션 없으면 reject 안 함', threw === false);
    check('heartbeat: 세션 없으면 요청도 안 보낸다', calls === 0, `calls=${calls}`);
  }

  // ④ 서버가 401을 줄 때 — reject하지 않고, **세션을 폐기해야** 다음 부팅이 재등록한다(자가 치유).
  {
    const store = memStorage(DEAD_SESSION);
    const sdk = createCommonServer({
      baseUrl: BASE, appCode: APP, appVersion: '1.0.0', platform: 'node', storage: store,
    });
    check('heartbeat: 401이어도 reject 안 함', (await rejects(() => sdk.heartbeat())) === false);
    check('heartbeat: 401이면 세션 폐기(자가 치유)', store.dump() === null, `stored=${store.dump()}`);
  }

  // ⑤ 쿨다운 — 5분 안에 다시 부르면 **요청이 안 나간다**. 서버는 멱등이라 중복이 무해하지만
  //    네트워크를 아끼는 건 앱의 몫이고, 포그라운드 복귀는 매우 자주 일어난다.
  {
    let calls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (...a: Parameters<typeof fetch>) => {
      calls++;
      return realFetch(...a);
    }) as typeof fetch;
    const sdk = createCommonServer({
      baseUrl: BASE, appCode: APP, appVersion: '1.0.0', platform: 'node', storage: memStorage(DEAD_SESSION),
    });
    await sdk.heartbeat();
    const afterFirst = calls;
    await sdk.heartbeat();
    await sdk.heartbeat();
    globalThis.fetch = realFetch;
    // ⚠ 첫 호출은 401을 받아 세션을 지우므로, 이후는 쿨다운이 아니라 '세션 없음'으로도 막힌다.
    //    둘 중 무엇이든 **요청이 더 안 나가는 것**이 확인하려는 바다.
    check('heartbeat: 첫 호출은 요청을 보낸다', afterFirst === 1, `calls=${afterFirst}`);
    check('heartbeat: 연속 호출은 요청을 안 보낸다', calls === afterFirst, `calls=${calls}`);
  }

  // ⑥ 🔴 **응답이 JSON이 아닐 때** — `res.json()`이 throw 한다.
  //    ①~⑤ 는 전부 `return` 으로 빠져나가서 **바깥 catch 를 한 번도 안 탄다**.
  //    그래서 catch 를 통째로 지워도 ①~⑤ 는 전부 통과한다(2026-09-02 변이 테스트로 확인).
  //    이 케이스가 그 블록에 이빨을 준다. 가상의 상황이 아니다 — 프록시·CDN·점검 페이지가
  //    200 에 HTML 을 실어 주는 일은 흔하고, 그때 앱은 조용히 넘어가야 한다.
  {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('<html>502 Bad Gateway</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as typeof fetch;
    const sdk = createCommonServer({
      baseUrl: BASE, appCode: APP, appVersion: '1.0.0', platform: 'node', storage: memStorage(DEAD_SESSION),
    });
    const threw = await rejects(() => sdk.heartbeat());
    globalThis.fetch = realFetch;
    check('heartbeat: 응답이 JSON이 아니어도 reject 안 함 (프록시가 HTML을 줄 때)', threw === false);
  }
}

// ── tokenAlive 가 exp 를 우선한다 (2026-09-02) ──────────────────────────────
// 만료 기준의 진실이 서버로 옮겨졌다. SESSION_TTL_DAYS 는 exp 없는 옛 토큰용 폴백으로만 남는다.
{
  const b64u = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const DAY = 86_400_000;
  const mem = (v: string | null) => {
    let cur = v;
    return {
      getItem: async () => cur,
      setItem: async (_k: string, val: string) => { cur = val; },
      removeItem: async () => { cur = null; },
    };
  };
  const mk = (v: string | null) =>
    createCommonServer({ baseUrl: BASE, appCode: APP, appVersion: '1.0.0', platform: 'node', storage: mem(v) });
  const tok = (o: object) => `${b64u({ sid: 'x', app: APP, ...o })}.sig`;

  const now = Date.now();
  // exp 가 이기는지 — iat 만 보면 정반대로 판정되는 값을 일부러 넣는다(폴백이 살아있으면 여기서 걸린다)
  check(
    'tokenAlive: exp 가 iat 보다 우선 — 오래된 iat + 미래 exp = 살아있음',
    (await mk(tok({ iat: now - 300 * DAY, exp: now + DAY })).isSignedIn()) === true,
  );
  check(
    'tokenAlive: exp 가 iat 보다 우선 — 방금 iat + 지난 exp = 죽음',
    (await mk(tok({ iat: now, exp: now - 1000 })).isSignedIn()) === false,
  );
  // exp 가 없으면 옛 규칙으로 폴백 — 안 그러면 기존 사용자가 전부 한 번에 로그아웃된다
  check('tokenAlive: exp 없는 옛 토큰은 iat 폴백(179일 → 살아있음)',
    (await mk(tok({ iat: now - 179 * DAY })).isSignedIn()) === true);
  check('tokenAlive: exp 없는 옛 토큰은 iat 폴백(181일 → 죽음)',
    (await mk(tok({ iat: now - 181 * DAY })).isSignedIn()) === false);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} — pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
