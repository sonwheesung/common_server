// 보관·파기 정책 — 개인정보를 목적 달성 후 지체 없이 파기한다(PIPA §21).
// 상수를 여기 한 곳에 모아 두어 크론·문서·가드가 같은 값을 본다.

/** 문의 보관기간(일). 3년 — 전자상거래법상 소비자 불만·분쟁 처리 기록 보존기간에 맞춘다. */
export const TICKET_RETENTION_DAYS = 3 * 365;

/** 종료된 공지의 파기 유예(일). 공지는 개인정보가 아니므로 파기 의무는 없고, 테이블 비대만 막는다. */
export const ANNOUNCEMENT_PURGE_AFTER_END_DAYS = 365;

/** now 기준 d일 전 시각. */
export const daysAgo = (d: number, now: Date = new Date()): Date => new Date(now.getTime() - d * 24 * 60 * 60 * 1000);
