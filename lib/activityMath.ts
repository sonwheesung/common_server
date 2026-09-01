// 활성 지표의 **순수 계산**만 — DB를 전혀 안 건드린다.
//
// 왜 파일을 나눔는가: "어떤 일별 카운트가 어떤 요일 평균이 되는가"가 이 기능의 전부인데,
// 그게 async DB 함수 안에 묻히면 가드가 소스 정규식으로밖에 못 본다.
// 여기 있으면 `node tools/_dv_activity.ts`가 실제로 **호출해서** 검증한다(DB 불필요).
// 런타임은 lib/activity.ts가 전부 re-export하므로 호출부는 그쪽만 보면 된다.

/** 요일 평균 집계 창. 요일당 표본 8일 — 짧으면 노이즈, 길면 성장 추세가 요일 차이로 위장된다. */
export const WEEKDAY_WINDOW_DAYS = 56;

/** 콘솔 추이 차트가 그리는 기간. */
export const SERIES_DAYS = 30;

/** 요일 차트를 그리기 시작하는 최소 수집일(요일당 2일 = 2주). 그 전엔 "수집 중"을 띄운다. */
export const WEEKDAY_MIN_SAMPLES = 2;

export const DAY_MS = 86_400_000;
/** 하루를 어느 시간대로 자를지는 **운영 판단**이라 DB(UTC)에 맡기지 않고 여기 명시한다. */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** UTC 시각 → KST 달력일 'YYYY-MM-DD'. */
export const kstYmd = (d: Date = new Date()): string =>
  new Date(d.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);

/** UTC 시각 → KST 시(0~23). 날짜를 접는 것과 같은 오프셋을 쓴다 — 여기가 어긋나면 분포가 통째로 밀린다. */
export const kstHour = (d: Date = new Date()): number => new Date(d.getTime() + KST_OFFSET_MS).getUTCHours();

/** 그 시각 하나를 나타내는 비트. `hours` 컬럼에 OR로 얹는다(멱등 · 순서 무관). */
export const hourBit = (d: Date = new Date()): number => 1 << kstHour(d);

/** 시간대 차트를 그리기 시작하는 최소 수집일. 하루치를 패턴으로 읽으면
 *  "그날 우연히 몰린 시각"이 생활패턴으로 둔갑한다. 요일차트의 2주 게이트와 같은 이유다. */
export const HOUR_MIN_DAYS = 3;

/** 시간대 차트를 그려도 되는가 — 판정 축은 **시각 비트를 모은 일수**다(날짜 수집일과 다르다). */
export const hourChartReady = (hourCoverageDays: number): boolean => hourCoverageDays >= HOUR_MIN_DAYS;

/** 표시 순서: 0시부터 23시까지. */
export const HOURS: readonly number[] = Array.from({ length: 24 }, (_, i) => i);

/** KST 달력일 'YYYY-MM-DD' → 요일(0=일 … 6=토).
 *  UTC 자정에 앵커해 읽는다 — 이미 KST로 접힌 날짜라 여기서 오프셋을 또 더하면 하루가 밀린다. */
export const dowOf = (ymd: string): number => new Date(`${ymd}T00:00:00Z`).getUTCDay();

/** 표시 순서: 월~일. 운영자가 주 단위로 읽는 순서이고 주말이 오른쪽 끝에 모여 눈에 잡힌다. */
export const MON_FIRST: readonly number[] = [1, 2, 3, 4, 5, 6, 0];
export const DOW_LABEL: Record<number, string> = { 0: '일', 1: '월', 2: '화', 3: '수', 4: '목', 5: '금', 6: '토' };

export interface WeekdayBucket {
  dow: number;
  label: string;
  /** 그 요일의 DAU 평균. **표본 0이면 null** — 없는 데이터를 0으로 그리지 않는다. */
  avg: number | null;
  samples: number;
}

/** 창 전체 날짜 키(오래된 → 최신). 활성 0인 날을 0으로 메우는 데 필요하다. */
export function windowDayKeys(days: number, now: Date = new Date()): string[] {
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i--) keys.push(kstYmd(new Date(now.getTime() - i * DAY_MS)));
  return keys;
}

/**
 * 일별 활성자 수 → 요일별 평균. **순수 함수**.
 *
 * @param daily [KST 날짜, 그날 활성자 수][] — 활성자가 0인 날도 **행으로 넣어야** 평균이 맞다.
 *              빠진 날을 "표본 없음"으로 두면 조용한 상향 편향이 생긴다(호출자가 0으로 메워 넘긴다).
 */
export function weekdayAverages(daily: readonly (readonly [string, number])[]): WeekdayBucket[] {
  const sum = new Array(7).fill(0);
  const cnt = new Array(7).fill(0);
  for (const [ymd, n] of daily) {
    const d = dowOf(ymd);
    if (!Number.isInteger(d) || d < 0 || d > 6) continue; // 파싱 실패는 버린다(집계가 NaN으로 오염되지 않게)
    sum[d] += n;
    cnt[d]++;
  }
  return MON_FIRST.map((d) => ({
    dow: d,
    label: DOW_LABEL[d],
    avg: cnt[d] > 0 ? Math.round((sum[d] / cnt[d]) * 10) / 10 : null,
    samples: cnt[d],
  }));
}

/**
 * 요일 차트를 그려도 되는가 = 요일당 최소 표본을 채울 만큼 **실제로 모았나**.
 *
 * ⚠ 판정 축이 `weekdayAverages`의 `samples`가 아니라 **수집 경과일**인 이유: samples는
 *   "그 요일에 해당한 날짜 수"라서 활성자가 0명이어도 창 길이만큼 채워진다. 그걸로 판정하면
 *   수집을 하루도 안 한 상태에서 차트가 "월요일 최다"라고 단언한다(배구 서버 실사고).
 */
export const weekdayChartReady = (coverageDays: number): boolean => coverageDays >= WEEKDAY_MIN_SAMPLES * 7;
