// 서버 레이트리밋 — Upstash Redis 슬라이딩 윈도.
//
// ★ 안전 원칙 (fail-open, 두 겹):
//   1) **미설정 fail-open**: URL/TOKEN 중 하나라도 없으면 리미터는 항상 허용(no-op).
//      → Upstash 세팅 전에도 안전하게 커밋할 수 있고, 로컬 dev는 절대 막히지 않는다.
//      모듈 로드 시점에 절대 throw하지 않도록 **지연 초기화**한다.
//   2) **Redis 오류 fail-open**: 검사 중 예외(다운/타임아웃)면 허용하고 reportError만.
//      인프라 딸꾹질에 정상 유저를 막지 않는다.
//
// ⚠ fail-open이라는 건 이것만으로는 방어가 안 된다는 뜻이다. 무인증 라우트의 실질 방어선은
//   DB 기반 일일 캡(lib/apps.ts の ticketDailyCap)이며, 그쪽은 fail-closed다.
import { reportError } from './observability';

// ── 튜너블 윈도 상수(가드가 이 값을 직접 읽어 드리프트 차단) ──
export const LIMITS = {
  ticket: { limit: 5, windowSec: 600 }, // 문의 접수: 5회/600초 (IP)
  bootstrap: { limit: 60, windowSec: 60 }, // 부팅 조회: 60회/60초 (IP) — 읽기라 넉넉히
} as const;

export type LimiterName = keyof typeof LIMITS;

type RatelimitLike = { limit: (id: string) => Promise<{ success: boolean }> };
let cachedLimiters: Record<LimiterName, RatelimitLike> | null = null;
let initTried = false;

/** env가 둘 다 있으면 Ratelimit 인스턴스 맵, 아니면 null(no-op → 항상 허용). */
function getLimiters(): Record<LimiterName, RatelimitLike> | null {
  if (initTried) return cachedLimiters;
  initTried = true;
  // Vercel Upstash 통합은 커스텀 프리픽스에 따라 이름이 갈린다(KV_REST_API_* / UPSTASH_REDIS_REST_*). 둘 다 인식.
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null; // 미설정 → fail-open no-op
  try {
    // 지연 require — 미설정 경로에선 모듈을 아예 안 만진다.
    const { Redis } = require('@upstash/redis') as typeof import('@upstash/redis');
    const { Ratelimit } = require('@upstash/ratelimit') as typeof import('@upstash/ratelimit');
    const redis = new Redis({ url, token });
    const make = (name: LimiterName): RatelimitLike =>
      new Ratelimit({
        redis,
        prefix: `rl:${name}`,
        limiter: Ratelimit.slidingWindow(LIMITS[name].limit, `${LIMITS[name].windowSec} s`),
      });
    cachedLimiters = { ticket: make('ticket'), bootstrap: make('bootstrap') };
    return cachedLimiters;
  } catch (e) {
    reportError(e, 'ratelimit/init');
    return null; // 초기화 실패도 fail-open
  }
}

/** 한도 검사. 미설정(no-op)·Redis 오류는 모두 허용(fail-open).
 *  identifier는 엔드포인트명으로 프리픽스해 cross-endpoint 키 충돌을 막는다. */
export async function checkLimit(name: LimiterName, identifier: string): Promise<{ ok: boolean }> {
  const limiters = getLimiters();
  if (!limiters) return { ok: true };
  try {
    const res = await limiters[name].limit(`${name}:${identifier}`);
    return { ok: res.success };
  } catch (e) {
    reportError(e, `ratelimit/${name}`);
    return { ok: true }; // Redis 장애 → 허용(정상 유저 보호)
  }
}

/** Vercel이 세팅하는 x-forwarded-for의 첫 홉(실 클라 IP). 없으면 'unknown'.
 *  ※ 레이트리밋 키로만 쓰고 **저장하지 않는다**(개인정보 최소수집). */
export function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.headers.get('x-real-ip')?.trim() || 'unknown';
}
