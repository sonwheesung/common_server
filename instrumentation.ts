// Sentry 초기화 — Next의 instrumentation 훅(서버 부팅 1회).
// 활성 판단은 lib/sentryGate.ts 한 곳에서만(observability.reportError와 공유 — 어긋나면 절반만 막힌다).
import { sentryEnabled } from './lib/sentryGate';

export async function register() {
  if (!sentryEnabled()) return;
  const Sentry = await import('@sentry/node');
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.VERCEL_ENV ?? 'unknown',
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0.1'),
  });
}

export async function onRequestError(err: unknown, request: { path?: string }) {
  if (!sentryEnabled()) return;
  const Sentry = await import('@sentry/node');
  Sentry.captureException(err, { tags: { where: request?.path ?? 'request' } });
  await Sentry.flush(2000);
}
