// 활성 지표 집계 가드 — **DB 불필요**. 순수 함수를 실제로 호출해서 본다.
//
//   node tools/_dv_activity.ts
//
// 여기서 지키는 것은 숫자가 아니라 **정직함**이다. 활성 집계는 틀려도 화면이 그럴듯해서
// 조용히 틀린다(배구 서버가 요일 차트에서 겪었다). 그래서 거짓말이 나오는 세 경로를 못박는다:
//   ① 빠진 날을 0으로 안 메우면 평균이 위로 편향된다
//   ② 표본 0인 요일을 0으로 그리면 "없는 데이터"가 "0명"으로 둔갑한다
//   ③ 수집을 하루도 안 했는데 차트를 그리면 우연을 경향으로 읽는다
import {
  DOW_LABEL,
  MON_FIRST,
  dowOf,
  kstYmd,
  weekdayAverages,
  weekdayChartReady,
  windowDayKeys,
  WEEKDAY_MIN_SAMPLES,
} from '../lib/activityMath.ts';

export {};

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

console.log('[_dv_activity] 순수 집계\n');

// ── ① KST 접기 ────────────────────────────────────────────────────────────────
// UTC 자정 직후는 KST로 이미 다음 날이다. 여기가 틀리면 DAU가 하루씩 밀린다.
check('KST 접기 — UTC 15:00 = 다음 날', kstYmd(new Date('2026-09-01T15:00:00Z')) === '2026-09-02');
check('KST 접기 — UTC 14:59 = 같은 날', kstYmd(new Date('2026-09-01T14:59:59Z')) === '2026-09-01');

// 요일: 2026-09-01은 화요일. 접힌 날짜를 다시 오프셋 더해 읽으면 여기서 하루가 밀린다.
check('요일 — 2026-09-01은 화(2)', dowOf('2026-09-01') === 2, String(dowOf('2026-09-01')));
check('요일 라벨 — 월 시작', MON_FIRST.map((d) => DOW_LABEL[d]).join('') === '월화수목금토일');

// ── ② 창 날짜 키 ──────────────────────────────────────────────────────────────
const keys = windowDayKeys(7, new Date('2026-09-01T03:00:00Z'));
check('창 길이', keys.length === 7, String(keys.length));
check('창은 오래된 → 최신', keys[0] < keys[6]);
check('창 끝이 오늘', keys[6] === kstYmd(new Date('2026-09-01T03:00:00Z')), keys[6]);

// ── ③ 요일 평균 ───────────────────────────────────────────────────────────────
// 같은 요일 두 날(월 10, 월 20) → 평균 15. 0인 날도 표본이다(월 10, 월 0 → 5).
const mon = weekdayAverages([
  ['2026-08-31', 10], // 월
  ['2026-09-07', 20], // 월
])[0];
check('요일 평균 = 표본 합/표본 수', mon.avg === 15 && mon.samples === 2, JSON.stringify(mon));

const withZero = weekdayAverages([
  ['2026-08-31', 10],
  ['2026-09-07', 0],
])[0];
check('활성 0인 날도 분모에 든다 (10,0 → 5)', withZero.avg === 5 && withZero.samples === 2, JSON.stringify(withZero));

// 표본이 없는 요일은 **null**이어야 한다. 0으로 채우면 "그 요일엔 아무도 안 왔다"는 거짓말이 된다.
const empty = weekdayAverages([['2026-08-31', 10]]);
const tue = empty.find((w) => w.dow === 2)!;
check('표본 0인 요일은 avg=null (0이 아니다)', tue.avg === null && tue.samples === 0, JSON.stringify(tue));
check('입력이 비어도 7칸 전부 null', weekdayAverages([]).every((w) => w.avg === null && w.samples === 0));

// 깨진 날짜는 조용히 버린다 — 집계 전체가 NaN으로 오염되면 화면이 통째로 빈다.
const dirty = weekdayAverages([
  ['2026-08-31', 10],
  ['not-a-date', 999],
]);
check(
  '깨진 날짜는 버린다 (NaN 오염 없음)',
  dirty.every((w) => w.avg === null || Number.isFinite(w.avg)),
  JSON.stringify(dirty.map((w) => w.avg)),
);

// ── ④ 차트 게이트 ─────────────────────────────────────────────────────────────
// 판정 축은 "며칠 지났나"가 아니라 "며칠어치를 모았나"다.
check('수집 0일이면 차트 안 그린다', weekdayChartReady(0) === false);
check(`수집 ${WEEKDAY_MIN_SAMPLES * 7 - 1}일이면 아직 아니다`, weekdayChartReady(WEEKDAY_MIN_SAMPLES * 7 - 1) === false);
check(`수집 ${WEEKDAY_MIN_SAMPLES * 7}일이면 그린다`, weekdayChartReady(WEEKDAY_MIN_SAMPLES * 7) === true);

// 창을 꽉 채운 표본이 있어도 **수집일이 0이면** 그리면 안 된다 — samples로 판정하면 여기서 통과해버린다.
const full = weekdayAverages(windowDayKeys(56, new Date('2026-09-01T03:00:00Z')).map((k) => [k, 0] as const));
check(
  'samples가 꽉 차도 수집 0일이면 게이트가 막는다',
  full.every((w) => w.samples > 0) && weekdayChartReady(0) === false,
);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} — pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
