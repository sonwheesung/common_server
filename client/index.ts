// 공통 서버 클라이언트 SDK.
//
// 이 모듈은 **throw 하지 않는다**. 네트워크가 끊겨 있든 서버가 없든 화면은 조용히 안내만 하면 되므로,
// 실패를 타입으로 돌려준다(호출부에서 try/catch를 강제하지 않는다).

import type { Bootstrap, CommonServerConfig, Result, SupportCategory } from './types';

export * from './types';

const DEFAULT_TIMEOUT_MS = 10000;
/** 서버가 요구하는 문의 최소 길이(라우트의 CONTENT_MIN과 같은 값). */
export const CONTENT_MIN = 5;
/** 서버가 자르는 상한. 입력창 maxLength를 이보다 크게 두지 않는다. */
export const CONTENT_MAX = 2000;

export function createCommonServer(cfg: CommonServerConfig) {
  const baseUrl = (cfg.baseUrl ?? '').replace(/\/$/, '');
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /** 응답 없이 매달리지 않도록 타임아웃을 건다(사용자가 로딩에 갇히는 것 방지). */
  async function req(path: string, init?: RequestInit): Promise<Response | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(`${baseUrl}${path}`, { ...init, signal: controller.signal });
    } catch {
      return null; // fetch 실패·abort는 모두 "지금은 못 함"으로 묶는다 — 사용자가 할 일은 같다(나중에 재시도)
    } finally {
      clearTimeout(timer);
    }
  }

  const mapFail = (status: number) =>
    status === 429 ? ('rate-limited' as const) : status === 404 ? ('not-found' as const) : ('error' as const);

  return {
    /** 서버 URL이 빌드에 박혀 있는지 — 화면에서 진입 자체를 막을지 판단할 때 쓴다. */
    isConfigured(): boolean {
      return baseUrl.length > 0;
    },

    /**
     * 부팅 조회: 점검 · 버전 게이트 · 활성 공지.
     * 실패해도 앱을 막지 말 것 — 서버가 죽었다고 사용자가 앱을 못 쓰면 안 된다(게이트는 성공했을 때만 적용).
     */
    async fetchBootstrap(): Promise<Result<{ data: Bootstrap }>> {
      if (!baseUrl) return { ok: false, reason: 'not-configured' };
      const res = await req(`/api/v1/bootstrap?app=${encodeURIComponent(cfg.appCode)}`);
      if (!res) return { ok: false, reason: 'offline' };
      if (!res.ok) return { ok: false, reason: mapFail(res.status) };
      try {
        const j = (await res.json()) as Bootstrap & { ok: boolean };
        return { ok: true, data: { maintenance: j.maintenance, version: j.version, announcements: j.announcements } };
      } catch {
        return { ok: false, reason: 'error' };
      }
    },

    /** 문의 접수 — 익명 단방향. 누가 보냈는지는 보내지 않는다(계정·기기 식별자 없음). */
    async sendInquiry(category: SupportCategory, content: string): Promise<Result<{}>> {
      const trimmed = content.trim();
      if (trimmed.length < CONTENT_MIN) return { ok: false, reason: 'too-short' };
      if (!baseUrl) return { ok: false, reason: 'not-configured' };

      const res = await req('/api/v1/tickets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          app: cfg.appCode,
          category,
          content: trimmed,
          device: { platform: cfg.platform, appVersion: cfg.appVersion },
        }),
      });
      if (!res) return { ok: false, reason: 'offline' };
      return res.ok ? { ok: true } : { ok: false, reason: mapFail(res.status) };
    },
  };
}

export type CommonServer = ReturnType<typeof createCommonServer>;

/**
 * 버전 비교 — 'a.b.c' 형태를 숫자로 비교한다. a < b 면 음수.
 * 게이트 판단은 앱이 한다: `compareVersions(APP_VERSION, boot.version.min) < 0` 이면 강제 업데이트.
 * 자리수가 다르면 없는 자리는 0으로 본다('1.2' vs '1.2.0' 은 같음).
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
