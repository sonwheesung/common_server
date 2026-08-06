// after()의 가드판 — 관찰 사이드채널(디스코드 알림·Sentry flush)이 응답을 오염시키지 않게.
// next/server의 after()는 요청 컨텍스트 밖(tsx 가드 스크립트·테스트)에서 throw 하므로,
// 무가드로 라우트에서 직접 부르면 "DB 반영은 됐는데 알림 예약이 throw → 500"이 난다(배구 서버 실사고).
import { after } from 'next/server';

/** 응답 후 실행 예약 — 요청 밖이면 즉시 실행(가드/스크립트). task는 throw-none이어야 함(알림·로그류). */
export function afterSafe(task: () => void | Promise<void>): void {
  try {
    after(task);
  } catch {
    void task();
  }
}
