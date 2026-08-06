// 관리자 라우트 라이브 가드 — **fail-closed가 진짜 닫혀 있는지**를 본다.
//
// 실행:  BASE_URL=... ADMIN_TOKEN=... node tools/_dv_admin.ts
//
// 관리자 라우트가 열려 있으면 공지 발행·문의 열람이 통째로 뚫린다. 그래서 무토큰·오토큰·짧은토큰을
// 전부 401로 돌려보내는지 확인한다. ADMIN_TOKEN을 주면 정상 경로(GET)도 함께 검증한다.

export {}; // 모듈로 취급되게(파일 스코프 격리 + top-level await 허용)

const BASE = (process.env.BASE_URL ?? 'http://localhost:3100').replace(/\/$/, '');
const TOKEN = process.env.ADMIN_TOKEN ?? '';

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

const get = (path: string, token?: string) =>
  fetch(`${BASE}/api/admin/${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : undefined);

console.log(`[_dv_admin] ${BASE}\n`);

const ROUTES = ['apps', 'announcements?app=myword', 'settings?app=myword', 'tickets?app=myword'];

for (const route of ROUTES) {
  check(`${route} 무토큰 401`, (await get(route)).status === 401);
  check(`${route} 오토큰 401`, (await get(route, 'wrong-token-but-long-enough-1234')).status === 401);
  check(`${route} 짧은토큰 401`, (await get(route, 'short')).status === 401);
}

// 크론도 같은 성질 — 파기는 되돌릴 수 없으므로 무인증 호출이 통과하면 안 된다(배포 환경 기준).
{
  const r = await fetch(`${BASE}/api/cron/purge`);
  const isDeployed = BASE.startsWith('https://');
  if (isDeployed) check('cron/purge 무인증 401', r.status === 401, `status=${r.status}`);
  else console.log(`  SKIP  cron/purge (로컬은 CRON_SECRET 미설정 시 허용 — 배포 URL로 실행할 것)`);
}

if (TOKEN) {
  const r = await get('apps', TOKEN);
  const j = (await r.json()) as { ok: boolean; apps: unknown[] };
  check('apps 정상 토큰 200', r.status === 200 && Array.isArray(j.apps), `status=${r.status}`);
} else {
  console.log('  SKIP  정상 경로 (ADMIN_TOKEN 을 주면 검증)');
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} — pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
