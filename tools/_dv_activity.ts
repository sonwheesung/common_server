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
  HOURS,
  HOUR_MIN_DAYS,
  calendarWeeks,
  heatLevel,
  hourCount,
  longestStreak,
  MON_FIRST,
  dowOf,
  hourBit,
  hourChartReady,
  kstHour,
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

// ── ⑤ 시각 비트 (2026-09-01) ───────────────────────────────────────────────
// 날짜를 접는 오프셋과 **같은 오프셋**을 써야 한다. 여기가 어긋나면 분포가 통째로 밀리는데,
// 그래프는 멀쩡해 보이므로 아무도 눈치채지 못한다.
{
  const at = (iso: string) => new Date(iso);
  check('KST 시각 — UTC 15:00 = 다음날 0시', kstHour(at('2026-09-01T15:00:00Z')) === 0);
  check('KST 시각 — UTC 00:00 = 09시', kstHour(at('2026-09-01T00:00:00Z')) === 9);
  check('KST 시각 — UTC 14:59 = 23시', kstHour(at('2026-09-01T14:59:00Z')) === 23);

  // 자정 경계에서 날짜와 시각이 **같은 방향으로** 넘어가야 한다(하나만 넘어가면 하루가 어긋난다).
  const edge = at('2026-09-01T15:00:00Z');
  check('자정 경계: 날짜와 시각이 함께 넘어간다', kstYmd(edge) === '2026-09-02' && kstHour(edge) === 0);

  check('비트는 시각의 거듭제곱', hourBit(at('2026-09-01T00:00:00Z')) === 1 << 9);
  check('23시 비트가 int4 안에 든다', hourBit(at('2026-09-01T14:59:00Z')) === 8_388_608);
  // OR이 멱등이라 같은 시각에 몇 번을 켜도 같은 값이다 — 하트비트가 세 곳인 이유가 여기 걸려 있다.
  const b = hourBit(at('2026-09-01T03:00:00Z'));
  check('같은 시각 OR은 멱등', (b | b) === b);
  check('다른 시각 OR은 둘 다 남는다', (hourBit(at('2026-09-01T03:00:00Z')) | hourBit(at('2026-09-01T04:00:00Z'))) !== b);

  check('HOURS는 0..23 24칸', HOURS.length === 24 && HOURS[0] === 0 && HOURS[23] === 23);
  check('시각 차트: 수집 0일이면 안 그린다', hourChartReady(0) === false);
  check(`시각 차트: 수집 ${HOUR_MIN_DAYS}일이면 그린다`, hourChartReady(HOUR_MIN_DAYS) === true);
}

// ── ⑥ 잔디(활동 달력) ──────────────────────────────────────────────────────
{
  check('hourCount — 0은 0', hourCount(0) === 0);
  check('hourCount — 비트 3개', hourCount((1 << 0) | (1 << 9) | (1 << 23)) === 3);
  check('hourCount — 24시간 전부', hourCount((1 << 24) - 1) === 24);

  check('heatLevel — 1시간은 1단계', heatLevel(1) === 1);
  check('heatLevel — 8시간은 4단계', heatLevel(8) === 4);

  // 격자는 **월요일 시작**이어야 한다 — 같은 화면의 요일 평균 차트와 축이 어긋나면
  // 같은 주를 두 번 다르게 읽게 된다. 2026-09-01은 화요일 → 첫 열 앞에 빈칸 1개.
  const w = calendarWeeks(['2026-09-01', '2026-09-02', '2026-09-03']);
  check('격자 — 월요일 시작 패딩', w[0][0] === null && w[0][1] === '2026-09-01', JSON.stringify(w[0]));
  check('격자 — 열은 항상 7칸', w.every((c) => c.length === 7));
  check('격자 — 입력이 비면 빈 배열', calendarWeeks([]).length === 0);

  check('연속 — 끊긴 구간 중 최대', longestStreak(['2026-09-01', '2026-09-02', '2026-09-05']) === 2);
  check('연속 — 순서가 섞여도 같다', longestStreak(['2026-09-05', '2026-09-02', '2026-09-01']) === 2);
  check('연속 — 빈 입력은 0', longestStreak([]) === 0);
  // 월을 넘는 연속이 끊기면 매달 1일마다 통계가 주저앉는다.
  check('연속 — 월경계를 넘는다', longestStreak(['2026-08-30', '2026-08-31', '2026-09-01']) === 3);
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
// 사유: 순수 함수라 환경 의존이 없다 — 줄면 무조건 이상이다
const MIN_CHECKS = 39;
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
