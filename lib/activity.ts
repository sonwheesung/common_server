// 활성 일자 기록·집계 — DAU/WAU/MAU와 요일 추이의 원천. 2026-09-01.
//
// **왜 별도 테이블인가**: `subjects.lastSeenAt`은 주체당 한 칸이라 덮어써진다. 매일 켠 사람도
// "오늘" 버킷에만 잡히므로 과거로 갈수록 조용히 과소 집계된다. 날짜 축은 최신 쪽으로 단조 편향되기
// 때문에 왜곡이 눈에 안 띈다 — 그래서 "언제 마지막에 봤나"와 "어느 날에 활성이었나"를 나눠 둔다.
//
// 순수 계산(요일 평균·날짜 접기)은 lib/activityMath.ts에 따로 있다 — 가드가 DB 없이 **호출해서** 검증하기 위해서다.
import { and, eq, lt, sql } from 'drizzle-orm';
import { db } from '../db';
import { subjectActiveDay, subjects } from '../db/schema';
import { ACTIVE_DAY_RETENTION_DAYS } from './retention';
import {
  DAY_MS,
  HOURS,
  SERIES_DAYS,
  WEEKDAY_WINDOW_DAYS,
  hourBit,
  hourChartReady,
  kstYmd,
  weekdayAverages,
  weekdayChartReady,
  windowDayKeys,
  type WeekdayBucket,
} from './activityMath';

// 순수 계산은 activityMath.ts에 있다(가드가 DB 없이 불러야 해서). 호출부는 여기만 보면 되게 re-export한다.
export * from './activityMath';

/**
 * 활성 기록 — 하트비트에서 부른다. 날짜 행은 PK 충돌 → DO NOTHING이라 멱등이고,
 * 그래서 하트비트 지점이 여러 곳이어도(bootstrap·devices·login) 하루 1행만 남는다.
 *
 * **`lastSeenAt`은 매번 갱신한다.** 처음엔 "새 행이 들어갔을 때만" 갱신해 쓰기를 1일 1회로
 * 묶었는데, 그러면 lastSeenAt이 **그날의 첫 접속 시각**에 고정돼 하루 안의 해상도가 사라진다.
 * "지금 몇 명 있나"(최근 30분)나 시간대별 분포 같은 지표가 그 순간 만들 수 없게 된다 —
 * 하루에 한 번 쓰나 열 번 쓰나 단일 행 PK UPDATE라 아낀 값이 잃은 것보다 작았다(2026-09-01 정정).
 *
 * 두 사실은 **역할이 다르다**: `subject_active_day`는 "어느 날에 활성이었나"(덮어써지지 않는 과거),
 * `lastSeenAt`은 "마지막으로 언제 봤나"(지금 이 순간). 둘 다 있어야 DAU와 실시간을 같이 말한다.
 *
 * **실패는 삼킨다.** 관측이 본 기능(부팅·로그인)을 막으면 안 된다.
 */
export async function recordActive(appCode: string, subjectId: string, now: Date = new Date()): Promise<void> {
  try {
    const bit = hourBit(now);
    await Promise.all([
      // 시각 비트를 OR로 얹는다 — 같은 시각에 몇 번을 켜도 결과가 같고(멱등), 도착 순서와도 무관하다.
      // 그래서 하트비트가 세 곳(bootstrap·devices·login)이어도 하루 1행이 유지된다.
      db
        .insert(subjectActiveDay)
        .values({ appCode, subjectId, day: kstYmd(now), hours: bit })
        .onConflictDoUpdate({
          target: [subjectActiveDay.appCode, subjectActiveDay.subjectId, subjectActiveDay.day],
          set: { hours: sql`${subjectActiveDay.hours} | ${bit}` },
        }),
      db.update(subjects).set({ lastSeenAt: now }).where(eq(subjects.id, subjectId)),
    ]);
  } catch {
    /* 관측 실패는 무시 */
  }
}

/** 보관기간 경과분 파기. 경과 기준 delete만 — 현재 데이터 무영향. 반환 = 지운 행 수. */
export async function purgeActiveDays(now: Date = new Date()): Promise<number> {
  const cutoff = kstYmd(new Date(now.getTime() - ACTIVE_DAY_RETENTION_DAYS * DAY_MS));
  const r = await db
    .delete(subjectActiveDay)
    .where(lt(subjectActiveDay.day, cutoff))
    .returning({ day: subjectActiveDay.day });
  return r.length;
}

export interface ActivitySummary {
  /** 오늘(KST) 활성 주체 수. */
  dau: number;
  /** 최근 7일 / 30일 순 활성 주체 수(중복 제거). */
  wau: number;
  mau: number;
  /** 최근 SERIES_DAYS일 일별 활성자 — 0인 날도 채워져 있다. */
  series: { day: string; n: number }[];
  /** 같은 창의 일별 **신규 주체** 수. 활성과 같은 축에 두어야 "새로 온 건지 돌아온 건지"가 보인다.
   *  ⚠ 이건 하트비트와 무관하게 **처음부터 쌓여 있는** 값이다(subjects.createdAt) — 수집 개시일과 무관하다. */
  signups: { day: string; n: number }[];
  weekday: WeekdayBucket[];
  /** KST 0~23시별 활성 **연인원**(주체×날짜). 창은 `series`와 같은 기간이다. */
  hours: { hour: number; n: number }[];
  /** 시각 비트를 실제로 모은 일수. **날짜 수집일과 다르다** — 시각은 2026-09-01부터 모은다. */
  hourCoverageDays: number;
  hourChartReady: boolean;
  /** 첫 기록일부터 오늘까지 며칠어치를 **모았나**. 0 = 수집 개시 전. */
  coverageDays: number;
  chartReady: boolean;
  windowDays: number;
}

/**
 * 앱 하나의 활성 지표. 요일 창(56일) 한 번만 스캔하고 나머지는 그 위에서 접는다.
 *
 * PK가 (app, subject, day)라 날짜별 `count(*)`가 곧 순 활성자 수다 — distinct가 필요 없다.
 * 반면 WAU/MAU는 여러 날에 걸치므로 `count(distinct subject_id)`가 맞다.
 */
export async function activitySummary(appCode: string, now: Date = new Date()): Promise<ActivitySummary> {
  const keys = windowDayKeys(WEEKDAY_WINDOW_DAYS, now);
  const from = keys[0];
  const seriesFrom = keys[keys.length - SERIES_DAYS] ?? from; // 시간대 분포는 series와 같은 창을 쓴다
  const today = kstYmd(now);
  const wauFrom = kstYmd(new Date(now.getTime() - 6 * DAY_MS)); // 오늘 포함 7일
  const mauFrom = kstYmd(new Date(now.getTime() - 29 * DAY_MS));

  const [daily, uniq, first, signup, hourly, hourFirst] = await Promise.all([
    db
      .select({ day: subjectActiveDay.day, n: sql<number>`count(*)::int` })
      .from(subjectActiveDay)
      .where(and(eq(subjectActiveDay.appCode, appCode), sql`${subjectActiveDay.day} >= ${from}`))
      .groupBy(subjectActiveDay.day),
    db
      .select({
        wau: sql<number>`count(distinct ${subjectActiveDay.subjectId}) filter (where ${subjectActiveDay.day} >= ${wauFrom})::int`,
        mau: sql<number>`count(distinct ${subjectActiveDay.subjectId}) filter (where ${subjectActiveDay.day} >= ${mauFrom})::int`,
      })
      .from(subjectActiveDay)
      .where(and(eq(subjectActiveDay.appCode, appCode), sql`${subjectActiveDay.day} >= ${mauFrom}`)),
    db
      .select({ first: sql<string | null>`min(${subjectActiveDay.day})` })
      .from(subjectActiveDay)
      .where(eq(subjectActiveDay.appCode, appCode)),
    // 신규 가입 — created_at을 **KST로 접어서** 세다. 활성 쪽과 같은 날짜 경계를 써야 두 차트가 나란히 비교된다.
    db
      .select({
        day: sql<string>`to_char(${subjects.createdAt} at time zone 'Asia/Seoul', 'YYYY-MM-DD')`,
        n: sql<number>`count(*)::int`,
      })
      .from(subjects)
      .where(
        and(
          eq(subjects.appCode, appCode),
          sql`${subjects.createdAt} >= (${from}::date - 1) at time zone 'Asia/Seoul'`,
        ),
      )
      .groupBy(sql`1`),
    // 시간대 분포 — generate_series로 비트를 펼친다. 24개 표현식을 손으로 쓰는 것보다
    // 한 곳에서만 틀릴 수 있어 안전하고, 인덱스(app_code, day)도 그대로 탄다.
    // 세는 단위는 **주체×날짜**(연인원)다: "그 시각에 활성이던 사람이 창 기간 동안 몇 번 있었나".
    db.execute(sql`
      select g.h::int as hour, count(*)::int as n
      from ${subjectActiveDay} s, generate_series(0, 23) g(h)
      where s.app_code = ${appCode} and s.day >= ${seriesFrom} and ((s.hours >> g.h) & 1) = 1
      group by g.h
    `),
    // 시각 수집 개시일 — 날짜 수집일과 **다르다**. hours는 2026-09-01부터 쌓기 시작했고
    // 그 이전 행은 0이라 히스토그램에 한 건도 기여하지 않는다(틀린 값 대신 없는 값).
    db
      .select({ first: sql<string | null>`min(${subjectActiveDay.day})` })
      .from(subjectActiveDay)
      .where(and(eq(subjectActiveDay.appCode, appCode), sql`${subjectActiveDay.hours} <> 0`)),
  ]);

  const per = new Map(daily.map((r) => [String(r.day).slice(0, 10), r.n]));
  const perSignup = new Map(signup.map((r) => [String(r.day).slice(0, 10), r.n]));
  const filled: [string, number][] = keys.map((k) => [k, per.get(k) ?? 0]);

  const perHour = new Map(
    ((hourly as unknown as { rows?: { hour: number; n: number }[] }).rows ?? (hourly as unknown as { hour: number; n: number }[])).map(
      (r) => [Number(r.hour), Number(r.n)],
    ),
  );

  /** 'YYYY-MM-DD' → 오늘까지 며칠어치인가(첫날 포함). 없으면 0. */
  const coverageFrom = (firstDay: string | null | undefined): number => {
    if (!firstDay) return 0;
    const start = Date.parse(`${String(firstDay).slice(0, 10)}T00:00:00Z`);
    const end = Date.parse(`${today}T00:00:00Z`);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
    return Math.floor((end - start) / DAY_MS) + 1;
  };

  // 수집 경과일 — 첫 기록일부터 오늘까지(첫날 포함). 한 행도 없으면 0.
  const coverageDays = coverageFrom(first[0]?.first);
  const hourCov = coverageFrom(hourFirst[0]?.first);

  return {
    dau: per.get(today) ?? 0,
    wau: uniq[0]?.wau ?? 0,
    mau: uniq[0]?.mau ?? 0,
    series: filled.slice(-SERIES_DAYS).map(([day, n]) => ({ day, n })),
    signups: keys.slice(-SERIES_DAYS).map((day) => ({ day, n: perSignup.get(day) ?? 0 })),
    weekday: weekdayAverages(filled),
    hours: HOURS.map((hour) => ({ hour, n: perHour.get(hour) ?? 0 })),
    hourCoverageDays: hourCov,
    hourChartReady: hourChartReady(hourCov),
    coverageDays,
    chartReady: weekdayChartReady(coverageDays),
    windowDays: WEEKDAY_WINDOW_DAYS,
  };
}
