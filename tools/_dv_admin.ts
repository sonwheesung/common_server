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

const patch = (path: string, token: string, body: unknown) =>
  fetch(`${BASE}/api/admin/${path}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

console.log(`[_dv_admin] ${BASE}\n`);

const ROUTES = [
  'apps',
  'announcements?app=myword',
  'settings?app=myword',
  'tickets?app=myword',
  'subjects?app=myword',
  'stats?app=myword',
];

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
  const j = (await r.json()) as { ok: boolean; apps: { appCode: string }[] };
  check('apps 정상 토큰 200', r.status === 200 && Array.isArray(j.apps), `status=${r.status}`);
  const codes = (j.apps ?? []).map((a) => a.appCode);
  const app = codes[0];

  if (!app) {
    console.log('  SKIP  앱별 검증 (등록된 앱 없음 — tools/seed.ts 로 먼저 등록)');
  } else {
    // ── stats: 알림·배선 상태 ─────────────────────────────────────────────
    const sr = await get(`stats?app=${app}`, TOKEN);
    const s = (await sr.json()) as {
      ok: boolean;
      kpi?: Record<string, number>;
      alerts?: { key: string; severity: string }[];
      infra?: Record<string, unknown>;
      errors?: { byReason: unknown[]; recent: unknown[] };
      activity?: {
        dau: number; wau: number; mau: number;
        series: { day: string; n: number }[];
        weekday: { avg: number | null; samples: number }[];
        coverageDays: number; chartReady: boolean;
      };
    };
    check('stats 200 + 형태', sr.status === 200 && !!s.kpi && Array.isArray(s.alerts) && !!s.errors, `status=${sr.status}`);
    check(
      'stats 알림 severity는 warn|crit 뿐',
      (s.alerts ?? []).every((a) => a.severity === 'warn' || a.severity === 'crit'),
    );
    // 🔴 배선 상태는 **붙었는지 여부만** 내려간다. 값이 새면 디스코드 웹훅 URL·RC 키가 콘솔로 유출된다.
    check(
      'stats infra는 boolean만 (시크릿 값 미유출)',
      !!s.infra && Object.values(s.infra).every((v) => typeof v === 'boolean'),
      JSON.stringify(s.infra),
    );

    // ── activity: 모은 만큼만 말하는가 ─────────────────────────
    const act = s.activity;
    check('stats activity 형태', !!act && Array.isArray(act.series) && Array.isArray(act.weekday), JSON.stringify(act ?? null));
    if (act) {
      // 요일은 항상 7칸 — 표본이 없으면 칸을 빼는 게 아니라 avg가 null이다.
      check('activity weekday 7칸', act.weekday.length === 7, String(act.weekday.length));
      // 수집 전에 chartReady가 true면 화면이 우연을 경향으로 단언한다(배구 서버 실사고).
      check(
        'activity 수집 전엔 chartReady=false',
        act.coverageDays > 0 || act.chartReady === false,
        `coverage=${act.coverageDays} ready=${act.chartReady}`,
      );
      // DAU ≤ WAU ≤ MAU — 순 사용자 수의 당연한 포함관계. 깨지면 distinct가 틀린 것.
      check('activity DAU ≤ WAU ≤ MAU', act.dau <= act.wau && act.wau <= act.mau, `${act.dau}/${act.wau}/${act.mau}`);
      // 0인 날도 행으로 와야 요일 평균이 맞는다(빠진 날을 표본 없음으로 두면 상향 편향).
      check('activity series가 0인 날을 메운다', act.series.length === 30, String(act.series.length));
    }

    // ── subjects: 개인정보 최소 노출 ───────────────────────────────────────
    const ur = await get(`subjects?app=${app}&limit=1`, TOKEN);
    const u = (await ur.json()) as { ok: boolean; total?: number; subjects?: Record<string, unknown>[] };
    check('subjects 200 + total', ur.status === 200 && typeof u.total === 'number', `status=${ur.status}`);
    // provider_id 원문은 운영 판독에 쓸 일이 없고, 유출 시 계정 특정에 쓰인다 — 내려보내지 않는다.
    check('subjects providerId 미노출', (u.subjects ?? []).every((r) => !('providerId' in r)));

    // ── tickets: 가드 문의 격리 ───────────────────────────────────────────
    const tr = await get(`tickets?app=${app}`, TOKEN);
    const t = (await tr.json()) as { ok: boolean; tickets?: { id: string; content: string }[]; devCount?: number };
    check('tickets 200 + devCount', tr.status === 200 && typeof t.devCount === 'number', `status=${tr.status}`);
    check(
      'tickets 기본 조회에 가드 문의(_dv_public)가 안 섞인다',
      (t.tickets ?? []).every((x) => !x.content.startsWith('[_dv_public]')),
    );

    // ── PATCH 앱 스코프 ───────────────────────────────────────────────────
    // 여긴 1배포 N앱이라 id만으로 UPDATE하면 다른 앱 티켓에 답변이 박힌다. 성공하면 안 되는 호출만 던진다.
    const someTicket = (t.tickets ?? [])[0]?.id;
    if (!someTicket) {
      console.log('  SKIP  PATCH 앱 스코프 (문의가 없음)');
    } else {
      const noApp = await patch('tickets', TOKEN, { id: someTicket, status: 'open' });
      check('tickets PATCH app 누락 400', noApp.status === 400, `status=${noApp.status}`);
      const other = codes.find((c) => c !== app);
      if (!other) {
        console.log('  SKIP  PATCH 타앱 스코프 (등록 앱이 하나뿐)');
      } else {
        const cross = await patch('tickets', TOKEN, { id: someTicket, app: other, status: 'open' });
        check(`tickets PATCH 타앱(${other}) id 404`, cross.status === 404, `status=${cross.status}`);
      }
    }
  }
} else {
  console.log('  SKIP  정상 경로 (ADMIN_TOKEN 을 주면 검증)');
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} — pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
