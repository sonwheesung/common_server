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

/** 스킵을 **이름으로** 기록한다. 개수만 세면 새 스킵이 옛 스킵 뒤에 숨는다(my-word 세션 지적, 2026-09-02).
 *  바닥(MIN_CHECKS)은 "몇 개 돌았나"를, 이건 "무엇이 안 돌았나"를 본다 — 둘 다 있어야 한다. */
const skipped: string[] = [];
function skip(name: string, why: string) {
  skipped.push(name);
  console.log(`  SKIP  ${name} — ${why}`);
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
  else skip('cron-purge', '로컬은 CRON_SECRET 미설정 시 허용 — 배포 URL로 실행할 것');
}

if (TOKEN) {
  const r = await get('apps', TOKEN);
  const j = (await r.json()) as { ok: boolean; apps: { appCode: string }[] };
  check('apps 정상 토큰 200', r.status === 200 && Array.isArray(j.apps), `status=${r.status}`);
  const codes = (j.apps ?? []).map((a) => a.appCode);
  const app = codes[0];

  if (!app) {
    skip('per-app', '등록된 앱 없음 — tools/seed.ts 로 먼저 등록');
  } else {
    // ── stats: 알림·배선 상태 ─────────────────────────────────────────────
    const sr = await get(`stats?app=${app}`, TOKEN);
    const s = (await sr.json()) as {
      ok: boolean;
      kpi?: Record<string, number>;
      alerts?: { key: string; severity: string }[];
      infra?: Record<string, unknown>;
      infraEnv?: Record<string, string>;
      alertChecks?: string[];
      errors?: { byReason: unknown[]; recent: unknown[] };
      activity?: {
        dau: number; wau: number; mau: number;
        series: { day: string; n: number }[];
        signups: { day: string; n: number }[];
        weekday: { avg: number | null; samples: number }[];
        hours: { hour: number; n: number }[];
        hourCoverageDays: number;
        hourChartReady: boolean;
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
      check('activity hours 24칸', act.hours.length === 24, String(act.hours.length));
      check(
        'activity hours가 0..23 순서',
        act.hours.every((h, i) => h.hour === i),
        JSON.stringify(act.hours.map((h) => h.hour)),
      );
      // 시각 수집일은 **날짜 수집일과 별개 축**이다. 시각 비트는 나중에 붙었으므로 더 짧거나 같다.
      check(
        'activity 시각 수집일 ≤ 날짜 수집일',
        act.hourCoverageDays <= act.coverageDays,
        `${act.hourCoverageDays} / ${act.coverageDays}`,
      );
      check(
        'activity 시각 수집 전엔 hourChartReady=false',
        act.hourCoverageDays >= 3 || act.hourChartReady === false,
        `coverage=${act.hourCoverageDays} ready=${act.hourChartReady}`,
      );
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
      // 신규 가입은 활성과 **같은 날짜 축**이어야 두 차트가 비교된다(한쪽이 UTC면 하루씩 어긋난다).
      check(
        'activity signups가 series와 같은 날짜 축',
        act.signups.length === act.series.length && act.signups.every((r, i) => r.day === act.series[i].day),
        `${act.signups.length} vs ${act.series.length}`,
      );
    }

    // 판정을 했다는 사실 자체를 내려보내야 화면이 "정상"과 "안 봤음"을 구분한다.
    check('stats alertChecks 비지 않음', (s.alertChecks ?? []).length > 0, JSON.stringify(s.alertChecks));
    // 최근 접속자는 전체 사용자의 부분집합이다. 넘으면 창 계산이나 필터가 틀린 것.
    // ⚠ DAU와는 비교하지 않는다 — KST 자정 직후엔 "30분 내 접속"이 어제 날짜에 속할 수 있어
    //   online ≤ dau가 정당하게 깨진다(그런 단언은 하필 새벽에만 터진다).
    check(
      'stats subjectsOnline ≤ subjects',
      (s.kpi?.subjectsOnline ?? 0) <= (s.kpi?.subjects ?? 0),
      `${s.kpi?.subjectsOnline} / ${s.kpi?.subjects}`,
    );
    check('stats onlineWindowMin 양수', (s.kpi?.onlineWindowMin ?? 0) > 0, String(s.kpi?.onlineWindowMin));
    // ⚠ infraEnv는 **env 이름**이지 값이 아니다. URL이 섮이면 그 순간 콘솔로 웹훅 시크릿이 새는 것이다.
    check(
      'stats infraEnv는 이름뿐 (값 미유출)',
      Object.values(s.infraEnv ?? {}).every((v) => typeof v === 'string' && !/https?:\/\//.test(v)),
      JSON.stringify(s.infraEnv),
    );

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
      skip('patch-scope', '문의가 없음');
    } else {
      const noApp = await patch('tickets', TOKEN, { id: someTicket, status: 'open' });
      check('tickets PATCH app 누락 400', noApp.status === 400, `status=${noApp.status}`);
      const other = codes.find((c) => c !== app);
      if (!other) {
        skip('patch-cross-app', '등록 앱이 하나뿐');
      } else {
        const cross = await patch('tickets', TOKEN, { id: someTicket, app: other, status: 'open' });
        check(`tickets PATCH 타앱(${other}) id 404`, cross.status === 404, `status=${cross.status}`);
      }
    }
  }
} else {
  skip('admin-happy-path', 'ADMIN_TOKEN 을 주면 검증');
}

// ── 주체 2행 구조 판정 (2026-09-02) ─────────────────────────────────────────
// 로그인 앱이 비로그인 활성을 재려고 기기 주체를 따로 두면 로그인한 사람은 device 1 + user 1 로
// **영구히 2행**이 된다(병합 개념 없음). 그 앱의 누적 `사용자` 수는 부풀어 있으므로 앱끼리
// 나란히 놓으면 그 앱만 과대평가된다 — 콘솔이 메타 줄과 타일 sub 로 그걸 말한다.
//
// ⚠ 판정 축은 **앱 코드가 아니라 데이터 모양**이다. 하드코딩하면 같은 구조의 앱이 새로 생겨도
//   경고가 안 뜨고, 그 앱이 구조를 바꿔도 경고가 안 사라진다.
//   그래서 **모든 앱**을 돈다 — 한 앱만 보면 하드코딩된 판정도 그 앱에서는 맞게 나온다.
//   (지금 등록된 4개 중 2행 구조는 조각뿐이라, 단일 종류 앱들이 대조군 역할을 한다.)
if (TOKEN) {
  const ar = await get('apps', TOKEN);
  const aj = (await ar.json()) as { apps?: { appCode: string }[] };
  const codes = (aj.apps ?? []).map((a) => a.appCode);
  if (codes.length === 0) {
    skip('dual-count', '등록된 앱 없음');
  } else {
    let dualSeen = 0;
    let singleSeen = 0;
    for (const code of codes) {
      const r = await get(`stats?app=${code}`, TOKEN);
      const j = (await r.json()) as {
        kpi?: { subjects: number; subjectKinds?: Record<string, number>; subjectsDualCounted?: boolean };
      };
      const kinds = j.kpi?.subjectKinds;
      if (!kinds || !j.kpi || typeof j.kpi.subjectsDualCounted !== 'boolean') {
        check(`${code}: subjectKinds·subjectsDualCounted 가 온다`, false, JSON.stringify(j.kpi));
        continue;
      }
      const nonZero = Object.values(kinds).filter((n) => Number(n) > 0).length;
      const expected = nonZero > 1;
      check(
        `${code}: 2행 판정이 데이터 모양과 일치`,
        j.kpi.subjectsDualCounted === expected,
        `kinds=${JSON.stringify(kinds)} dual=${j.kpi.subjectsDualCounted} expected=${expected}`,
      );
      // 합이 누적 사용자 수와 어긋나면 둘 중 하나가 필터를 다르게 걸고 있다는 뜻이다
      // (예: 한쪽만 탈퇴자를 빼면 화면의 두 숫자가 조용히 안 맞는다).
      const sum = Object.values(kinds).reduce((a, b) => a + Number(b), 0);
      check(`${code}: subjectKinds 합 = kpi.subjects`, sum === j.kpi.subjects, `sum=${sum} total=${j.kpi.subjects}`);
      if (expected) dualSeen++;
      else singleSeen++;
    }
    // 대조군이 둘 다 있어야 이 검사에 의미가 있다. 없으면 통과가 아니라 **못 봤다**고 말한다 —
    // "전부 단일 종류"인 상태에서는 하드코딩된 판정도 이 가드를 통과한다.
    if (dualSeen === 0 || singleSeen === 0) {
      console.log(
        `  NOTE  2행/단일 대조군이 한쪽뿐 (dual=${dualSeen} single=${singleSeen}) — 하드코딩 여부는 이 상태에서 판별 불가`,
      );
    } else {
      check('2행 앱과 단일 앱이 둘 다 있어 판정이 실제로 갈렸다', true, `dual=${dualSeen} single=${singleSeen}`);
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
const KNOWN_SKIPS = ['cron-purge', 'per-app', 'patch-scope', 'patch-cross-app', 'admin-happy-path', 'dual-count'];
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
// 사유: ADMIN_TOKEN 이 없으면 대부분 스킵된다 — 그때 걸리는 게 맞다
const MIN_CHECKS = 45;
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
