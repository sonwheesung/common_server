// Sentry 활성 게이트 — **단일 판단처**.
//
// 왜: Next는 dev에서도 `.env.local`을 로드한다. 거기 운영 DSN이 있으면 **로컬 dev 서버가 운영 Sentry로 에러를 전송**한다.
//   가드가 의도적으로 500을 대량 생성하면 그대로 운영 이슈·알림 폭주(배구 서버에서 실제로 난 사고).
//   `.env.development.local`에 빈 DSN을 넣는 로컬 대증요법은 gitignore라 다른 머신·CI·새 클론에선 다시 샌다
//   → 코드에 환경 게이트를 둔다.
//
// 규칙(우선순위 순):
//   1. DSN 없음/빈값 → 항상 비활성(미연결에서도 정상 기동).
//   2. `SENTRY_FORCE_LOCAL=1` → 로컬에서도 활성(탈출구 — 연동 검증 전용).
//   3. 그 외엔 **Vercel 배포 환경에서만**: `VERCEL_ENV`가 'production' | 'preview'.
//      `vercel dev`(로컬)은 'development'라 제외 — "VERCEL_ENV 존재 여부"보다 화이트리스트가 정확하다.
//
// ⚠ instrumentation.ts(init·onRequestError)와 lib/observability.ts(reportError)가 이 판단을 **공유**한다.
//   두 곳이 어긋나면 절반만 막혀 또 샌다. 순수 함수(부작용·import 0) — 가드가 라이브 전송 없이 검증 가능.

/** Sentry로 실제 전송할 환경인가 — init·onRequestError·reportError가 공유하는 단일 판단. */
export function sentryEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (!env.SENTRY_DSN) return false; // (1) DSN 없음/빈 문자열 = 완전 no-op
  if (env.SENTRY_FORCE_LOCAL === '1') return true; // (2) 탈출구(연동 검증)
  return env.VERCEL_ENV === 'production' || env.VERCEL_ENV === 'preview'; // (3) 배포에서만
}
