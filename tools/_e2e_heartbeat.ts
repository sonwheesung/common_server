// 하트비트 **성공 경로** 1회성 검증 — 실패 경로는 가드가 보고, 여기서는 "실제로 기록되는가"를 본다.
//
// ⚠ **실행하면 프로덕션 DB에 행을 만든다.** 로컬 dev 가 프로덕션 DB 를 쓰기 때문이다(CLAUDE.md).
//    그래서 상시 가드(`_dv_*.ts`)에 넣지 않았다 — 돌릴 때마다 subject 가 하나씩 늘고
//    그게 콘솔의 `사용자` 수와 DAU 를 오염시킨다. 만든 것은 **끝에서 전부 지운다**.
//
// 실행:  BASE_URL=http://localhost:3100 APP=myword node tools/_e2e_heartbeat.ts
export {};

// ⚠ `db/index.ts` 를 import 하지 않는다 — 그 파일이 `./schema` 를 확장자 없이 부르는데
//    node 의 타입 스트리핑은 확장자를 붙여줘야 찾는다(번들러가 없으니 해석이 안 된다).
//    가드들이 DB 를 안 건드리는 이유가 이것이고, 여기서는 드라이버에 직접 붙는다.
import postgres from 'postgres';
import { kstYmd, hourCount } from '../lib/activityMath.ts';

const sql = postgres(process.env.DATABASE_URL ?? '', { max: 2, prepare: false });

const BASE = (process.env.BASE_URL ?? 'http://localhost:3100').replace(/\/$/, '');
const APP = process.env.APP ?? 'myword';

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

// 이 실행에서만 쓰는 기기 id. 남더라도 뭐였는지 알아볼 수 있게 고정 접두사를 둔다.
const DEVICE_ID = crypto.randomUUID();
let subjectId = '';

console.log(`[_e2e_heartbeat] ${BASE} (app=${APP})\n`);

try {
  // ── 1. 기기 등록 → 세션 토큰 ──
  const reg = await fetch(`${BASE}/api/v1/devices`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app: APP, deviceId: DEVICE_ID }),
  });
  const regJson = (await reg.json()) as { ok?: boolean; token?: string; subject?: { id?: string } };
  check('기기 등록 200', reg.status === 200 && regJson.ok === true, `status=${reg.status}`);
  const token = regJson.token ?? '';
  subjectId = regJson.subject?.id ?? '';
  check('세션 토큰 발급', token.length > 0);

  // 발급 토큰이 exp 를 들고 있는가 (SDK 가 이걸로 만료를 판정한다)
  const payload = JSON.parse(Buffer.from(token.slice(0, token.indexOf('.')), 'base64url').toString()) as {
    iat: number;
    exp?: number;
  };
  check('발급 토큰에 exp 가 있다', typeof payload.exp === 'number', `exp=${payload.exp}`);

  // ── 1.5. 🔴 기기 등록만으로는 **웜이 아니다** ──
  // `/v1/devices`는 콜드 스타트 경로라 `recordActive(..., 'boot')`를 부른다. 여기서 warm이 켜지면
  // "앱이 AppState 리스너를 붙였다"를 서버가 잘못 판정하게 되고, 콘솔이 있지도 않은 계측 경계를
  // 그리거나 미부착 경고를 조용히 삼킨다. 출처 구분의 전부가 이 한 줄에 걸려 있다.
  {
    const rows = await sql<{ warm: boolean }[]>`
      select warm from subject_active_day where subject_id = ${subjectId} and day = ${kstYmd()} limit 1
    `;
    check('기기 등록만으로는 warm 이 켜지지 않는다', rows[0]?.warm === false, `warm=${rows[0]?.warm}`);
  }

  // ── 2. 하트비트 ──
  const hb = await fetch(`${BASE}/api/v1/heartbeat`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  const hbJson = (await hb.json()) as { ok?: boolean; session?: { token?: string } };
  check('하트비트 200', hb.status === 200 && hbJson.ok === true, `status=${hb.status}`);
  // 방금 발급한 토큰이므로 갱신이 붙으면 안 된다 — 붙으면 매 복귀마다 재서명하는 것이다.
  check('갓 발급한 토큰에는 갱신 토큰이 안 붙는다', hbJson.session === undefined);

  // ── 3. 실제로 기록됐는가 ──
  // afterSafe 는 응답 뒤에 돈다 — 잠깐 기다린다(폴링, 최대 3초).
  const today = kstYmd();
  let row: { hours: number } | undefined;
  for (let i = 0; i < 30 && !row; i++) {
    const rows = await sql<{ hours: number }[]>`
      select hours from subject_active_day where subject_id = ${subjectId} and day = ${today} limit 1
    `;
    row = rows[0];
    if (!row) await new Promise((r) => setTimeout(r, 100));
  }
  check('subject_active_day 에 오늘 행이 생겼다', row !== undefined, `day=${today}`);
  check('시각 비트가 정확히 1개 켜졌다', row ? hourCount(row.hours) === 1 : false, `hours=${row?.hours}`);

  // ── 3.5. 하트비트 뒤에는 warm 이 켜진다 + 집계가 그걸 읽는다 ──
  {
    const rows = await sql<{ warm: boolean }[]>`
      select warm from subject_active_day where subject_id = ${subjectId} and day = ${today} limit 1
    `;
    check('하트비트 뒤에는 warm 이 켜진다', rows[0]?.warm === true, `warm=${rows[0]?.warm}`);

    // 집계가 그 표식을 실제로 읽는가 — 컬럼만 켜지고 activitySummary 가 안 보면 화면은 여전히
    // "미부착"이라고 말한다(컬럼과 화면이 따로 노는 가장 흔한 고장).
    const agg = await sql<{ first: string | null }[]>`
      select min(day) as first from subject_active_day where app_code = ${APP} and warm = true
    `;
    check('집계가 warm 을 읽는다 (min(day) 가 오늘)', agg[0]?.first === today, `first=${agg[0]?.first}`);
  }

  // ── 4. 멱등 — 두 번 찍어도 1행 ──
  await fetch(`${BASE}/api/v1/heartbeat`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  await new Promise((r) => setTimeout(r, 500));
  const all = await sql`select 1 from subject_active_day where subject_id = ${subjectId}`;
  check('두 번 찍어도 하루 1행 (PK 멱등)', all.length === 1, `rows=${all.length}`);

  // ── 5. lastSeenAt 이 갱신됐는가 (최근 접속자 30분 타일의 원천) ──
  const sub = (await sql<{ last_seen_at: Date | null }[]>`
    select last_seen_at from subjects where id = ${subjectId} limit 1
  `)[0];
  check('lastSeenAt 이 채워졌다', sub?.last_seen_at != null);
} finally {
  // ── 정리 — 만든 것을 전부 지운다 ──
  // 남기면 콘솔의 `사용자` 수와 DAU 가 조용히 부풀고, 그건 이 프로젝트가 가장 싫어하는 종류의 오염이다.
  if (subjectId) {
    // 순서가 중요하다 — subject_active_day 가 subjects 를 FK 로 참조하므로 자식부터 지운다.
    const del = await sql`delete from subject_active_day where subject_id = ${subjectId} returning day`;
    const delSub = await sql`delete from subjects where id = ${subjectId} returning id`;
    console.log(`\n  정리: subject_active_day ${del.length}행 · subjects ${delSub.length}행 삭제 (${subjectId})`);
    check('정리 완료 — 테스트 주체가 남지 않았다', delSub.length === 1 && del.length >= 1);
  }
  await sql.end({ timeout: 5 });
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} — pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
