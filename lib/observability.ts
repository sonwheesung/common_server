// 서버 에러 리포트 단일 진입점 — API 라우트 catch에서 호출.
//
// ★ 서버리스(Vercel) flush: @sentry/node는 이벤트를 **비동기 전송**하는데 Vercel 함수는 응답 직후 얼어붙어(freeze)
//   전송 완료 전에 죽어 이벤트가 유실된다. Next의 after()(Vercel이 waitUntil로 함수를 살려둠)로 응답 뒤 flush한다.
// ★ 환경 게이트: sentryEnabled()가 false면 캡처 자체를 안 한다(instrumentation과 같은 판단 공유).
import * as Sentry from '@sentry/node';
import { afterSafe } from './afterSafe';
import { sentryEnabled } from './sentryGate';

export function reportError(e: unknown, where?: string): void {
  if (!sentryEnabled()) return; // 비배포(로컬)·DSN 미설정 = 완전 no-op
  try {
    Sentry.captureException(e, where ? { tags: { where } } : undefined);
    afterSafe(async () => {
      await Sentry.flush(2000);
    }); // 응답 후 전송 보장(서버리스). 요청 밖이면 즉시 flush
  } catch {
    /* 관측 실패는 무시 — 요청 흐름 보존 */
  }
}
