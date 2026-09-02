// 인증 라우트 라이브 가드 — **열리면 안 되는 것이 닫혀 있는지**를 본다.
//
// 실행:  BASE_URL=https://common-server.vercel.app APP=myword node tools/_dv_auth.ts
//
// 인증은 잘못 열리면 곧 계정 도용이다. 특히 두 가지를 못 박는다:
//   1) 검증기가 없는 공급자(kakao·apple)는 **어떤 값을 줘도** 통과하지 않는다
//   2) 무효한 세션 토큰으로 남의 문의를 조회할 수 없다
import crypto from 'node:crypto';
import { TOKEN_RENEW_AFTER_MS, TOKEN_TTL_MS, shouldRenew } from '../lib/auth/session.ts';

export {};

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

/** 스킵을 **이름으로** 기록한다. 개수만 세면 새 스킵이 옛 스킵 뒤에 숨는다(my-word 세션 지적, 2026-09-02).
 *  바닥(MIN_CHECKS)은 "몇 개 돌았나"를, 이건 "무엇이 안 돌았나"를 본다 — 둘 다 있어야 한다. */
const skipped: string[] = [];
function skip(name: string, why: string) {
  skipped.push(name);
  console.log(`  SKIP  ${name} — ${why}`);
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

console.log(`[_dv_auth] ${BASE} (app=${APP})\n`);

// 위조 토큰 — 형식만 그럴듯하고 서명은 가짜
const FORGED = 'eyJhbGciOiJIUzI1NiJ9.eyJzaWQiOiJmYWtlIiwiYXBwIjoibXl3b3JkIiwiaWF0Ijo5OTk5OTk5OTk5OTk5fQ.ZmFrZXNpZ25hdHVyZQ';

// ── 로그인 ──
{
  // 미구현 공급자는 설정 여부와 무관하게 거부돼야 한다
  for (const provider of ['kakao', 'apple', 'dev', 'anything']) {
    const r = await post('/api/v1/auth/login', { app: APP, provider, idToken: 'whatever' });
    check(`login 미구현 공급자(${provider}) 거부`, r.status === 401, `status=${r.status}`);
  }

  // 구글이지만 토큰이 가짜 — 서명 검증에서 떨어져야 한다
  const r = await post('/api/v1/auth/login', { app: APP, provider: 'google', idToken: FORGED });
  check('login 위조 구글 토큰 거부', r.status === 401, `status=${r.status}`);

  // 미등록 앱은 존재를 노출하지 않는다
  const r2 = await post('/api/v1/auth/login', { app: '__nope__', provider: 'google', idToken: FORGED });
  check('login 미등록 앱 404', r2.status === 404, `status=${r2.status}`);
}

// ── 세션이 필요한 라우트 ──
{
  const cases: [string, string, RequestInit | undefined][] = [
    ['/api/v1/auth/me', '무토큰', undefined],
    ['/api/v1/auth/me', '위조토큰', { headers: { authorization: `Bearer ${FORGED}` } }],
    ['/api/v1/tickets/mine', '무토큰', undefined],
    ['/api/v1/tickets/mine', '위조토큰', { headers: { authorization: `Bearer ${FORGED}` } }],
  ];
  for (const [path, label, init] of cases) {
    const r = await fetch(`${BASE}${path}`, init);
    check(`${path} ${label} 401`, r.status === 401, `status=${r.status}`);
  }

  // 탈퇴는 되돌릴 수 없다 — 무인증으로 절대 열리면 안 된다
  const del = await fetch(`${BASE}/api/v1/auth/me`, { method: 'DELETE' });
  check('auth/me DELETE 무토큰 401', del.status === 401, `status=${del.status}`);
}

// ── 문의 접수의 선택적 인증 ──
{
  // 헤더가 없으면 익명 접수 — 짧은 본문으로 400을 유도해 "인증 이전 단계까지 갔는지"만 본다
  const anon = await post('/api/v1/tickets', { app: APP, category: 'etc', content: 'x' });
  check('tickets 무토큰은 익명 경로(400 도달)', anon.status === 400, `status=${anon.status}`);

  // 헤더가 있는데 무효면 **조용히 익명으로 강등하지 않고** 401이어야 한다.
  // 강등하면 로그인 사용자의 문의가 귀속 없이 저장돼 답변을 영영 못 받는다.
  const bad = await post(
    '/api/v1/tickets',
    { app: APP, category: 'etc', content: '충분히 긴 본문입니다' },
    { authorization: `Bearer ${FORGED}` },
  );
  check('tickets 무효 토큰은 익명 강등 없이 401', bad.status === 401, `status=${bad.status}`);
}

// ── 토큰 슬라이딩 갱신 (2026-09-01) ──────────────────────────────────────────
// 왜 가드가 필요한가: 발급 경로가 로그인·기기등록 둘뿐이라 종전엔 iat+180일이 **고정 카운트다운**이었다.
//   앱을 매일 써도 그날이 오면 토큰이 죽고, bootstrap은 무효 토큰을 401 없이 조용히 무시하므로
//   그 사용자는 DAU에서 영구히 사라졌다 — 앱도 서버도 모르는 채로. 경계가 틀리면 그게 그대로 재현된다.
{
  const DAY = 86_400_000;
  const now = Date.now();
  check('갱신 임계가 TTL보다 짧다 (안 그러면 갱신이 영원히 안 온다)', TOKEN_RENEW_AFTER_MS < TOKEN_TTL_MS);
  check('방금 발급한 토큰은 갱신 대상 아님', shouldRenew(now, now) === false);
  check('임계 1ms 전은 아직 아님', shouldRenew(now - TOKEN_RENEW_AFTER_MS + 1, now) === false);
  check('임계 정각부터 갱신', shouldRenew(now - TOKEN_RENEW_AFTER_MS, now) === true);
  // iat이 깨졌으면 갱신하지 않는다 — 검증(verifySession)이 이미 거르지만, 여기서도 NaN이 통과하면 안 된다.
  check('iat이 숫자가 아니면 갱신 안 함', shouldRenew(Number.NaN, now) === false);
}

// 살아있지 않은 주체의 토큰은 **연장해주지 않는다**. 서명이 유효해도 마찬가지다 —
// 탈퇴한 세션을 연장하는 것 자체가 틀렸다(권한은 requireSubject가 따로 막지만 그건 다른 층이다).
{
  const secret = process.env.SESSION_JWT_SECRET ?? '';
  if (secret.length < 32) {
    skip('renew-live', 'SESSION_JWT_SECRET 필요');
  } else {
    const b64 = (v: Buffer | string) => Buffer.from(v as Buffer).toString('base64url');
    const sign = (claims: object) => {
      const body = b64(JSON.stringify(claims));
      return `${body}.${b64(crypto.createHmac('sha256', secret).update(body).digest())}`;
    };
    // 존재하지 않는 주체 + 갱신 임계를 넘긴 iat → 서명은 유효하지만 갱신은 나오면 안 된다.
    const ghost = sign({ sid: crypto.randomUUID(), app: APP, iat: Date.now() - TOKEN_RENEW_AFTER_MS - 1000 });
    const r = await fetch(`${BASE}/api/v1/bootstrap?app=${APP}`, { headers: { authorization: `Bearer ${ghost}` } });
    const j = (await r.json()) as { ok?: boolean; session?: unknown };
    check('없는 주체의 오래된 토큰: bootstrap은 200', r.status === 200, `status=${r.status}`);
    check('없는 주체의 토큰은 갱신해주지 않는다', j.session === undefined, JSON.stringify(j.session ?? null));

    // 방금 발급한 토큰은 갱신이 붙으면 안 된다 — 매 부팅 재발급은 저장소를 쓸데없이 두드린다.
    const fresh = sign({ sid: crypto.randomUUID(), app: APP, iat: Date.now() });
    const r2 = await fetch(`${BASE}/api/v1/bootstrap?app=${APP}`, { headers: { authorization: `Bearer ${fresh}` } });
    const j2 = (await r2.json()) as { session?: unknown };
    check('갓 발급한 토큰에는 갱신이 안 붙는다', j2.session === undefined, JSON.stringify(j2.session ?? null));
  }
}

// ── exp 클레임 (2026-09-02) ──────────────────────────────────────────────────
// 만료 기준을 서버 한 곳으로 모았다. 종전엔 서버 TOKEN_TTL_MS 와 SDK SESSION_TTL_DAYS 에
// **복제**돼 있어서, 누가 서버만 바꾸면 조용히 갈라졌다(그리고 양쪽 다 조용히 틀린다).
{
  const { signSession, verifySession, TOKEN_TTL_MS } = await import('../lib/auth/session.ts');

  const tok = signSession({ sid: '00000000-0000-4000-8000-000000000000', app: APP });
  if (!tok) {
    check('exp: 시크릿이 있어야 이 절을 검증한다 (SESSION_JWT_SECRET 미설정)', false, 'signSession → null');
  } else {
    const payload = JSON.parse(Buffer.from(tok.slice(0, tok.indexOf('.')), 'base64url').toString()) as {
      iat: number;
      exp?: number;
    };
    check('exp: 새 토큰은 exp 를 싣는다', typeof payload.exp === 'number', `exp=${payload.exp}`);
    check('exp: exp = iat + TOKEN_TTL_MS', payload.exp === payload.iat + TOKEN_TTL_MS);

    const v = verifySession(tok);
    check('exp: 검증 결과에 exp 가 실려 나온다', v?.exp === payload.exp);
    check('exp: iat 도 그대로 (슬라이딩 갱신 판정용)', v?.iat === payload.iat);
  }

  // 🔴 기발급분 호환 — exp 가 없는 옛 토큰이 **여전히 통과해야 한다**.
  //    안 그러면 이 배포 순간 기존 사용자가 전부 로그아웃되고, bootstrap 은 그걸 조용히 무시하므로
  //    그 사용자들은 DAU 에서 통째로 사라진다(아무도 모르게).
  {
    const { verifySession } = await import('../lib/auth/session.ts');
    const crypto = await import('node:crypto');
    const key = process.env.SESSION_JWT_SECRET ?? '';
    if (key.length >= 32) {
      const legacy = (iatOffsetMs: number) => {
        const body = Buffer.from(
          JSON.stringify({ sid: '00000000-0000-4000-8000-000000000000', app: APP, iat: Date.now() - iatOffsetMs }),
        ).toString('base64url');
        const sig = crypto.createHmac('sha256', key).update(body).digest('base64url');
        return `${body}.${sig}`;
      };
      const DAY = 86_400_000;
      check('exp: 없는 옛 토큰도 통과 (iat 폴백)', verifySession(legacy(10 * DAY)) !== null);
      check('exp: 없는 옛 토큰이 TTL 을 넘겼으면 거부', verifySession(legacy(181 * DAY)) === null);
    } else {
      skip('exp-fallback', 'SESSION_JWT_SECRET 미설정(로컬)');
    }
  }
}

// ── 🔴 **예상 밖의 스킵**을 잡는다 (2026-09-02) ──────────────────────────────
// 바닥(MIN_CHECKS)은 "몇 개 돌았나"를 본다. 그것만으로는 **새 스킵이 옛 스킵 뒤에 숨는다** —
// 정당한 스킵이 이미 개수를 깎아두면, 다른 섹션이 하나 더 죽어도 바닥 안에 들어올 수 있다.
// 그래서 개수와 **이름**을 함께 본다(my-word 세션 지적: 개수로 봐주지 말고 이름으로 잡아라).
//
// ⚠ 여기 이름들은 **환경 조건부**라 안 도는 게 정상인 것들이다(고장난 것이 아니다).
//   새 스킵을 추가하면 이 목록에도 등록해야 하고, **등록을 잊으면 여기서 걸린다** — 그게 요점이다.
const KNOWN_SKIPS = ['renew-live', 'exp-fallback'];
{
  const unknown = skipped.filter((n) => !KNOWN_SKIPS.includes(n));
  if (unknown.length > 0) {
    fail++;
    console.log(`  FAIL  등록되지 않은 스킵: ${unknown.join(', ')} — KNOWN_SKIPS 에 없다`);
  }
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
// 사유: exp 폴백 2건은 SESSION_JWT_SECRET 없으면 스킵된다
const MIN_CHECKS = 25;
{
  const ran = pass + fail;
  if (ran < MIN_CHECKS) {
    fail++;
    console.log(
      `  FAIL  가드가 줄었다 — ${ran}개만 돌았다(최소 ${MIN_CHECKS}). 섹션이 스킵됐거나 로드에 실패했다`,
    );
  }
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} — pass=${pass} fail=${fail} (실행 ${pass + fail} / 최소 ${MIN_CHECKS}${skipped.length ? ` · 스킵 ${skipped.length}: ${skipped.join(',')}` : ''})`);
process.exit(fail === 0 ? 0 : 1);
