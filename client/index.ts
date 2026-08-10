// 공통 서버 클라이언트 SDK.
//
// 이 모듈은 **throw 하지 않는다**. 네트워크가 끊겨 있든 서버가 없든 화면은 조용히 안내만 하면 되므로,
// 실패를 타입으로 돌려준다(호출부에서 try/catch를 강제하지 않는다).

import type {
  AuthProviderId,
  Bootstrap,
  CommonServerConfig,
  EntitlementView,
  MyInquiry,
  Result,
  Subject,
  SupportCategory,
} from './types';

// types.ts에는 런타임 값이 하나도 없다. `export *`로 두면 실제 import가 남아 소비자 번들에
// 빈 모듈 해석이 끼고, 확장자 없는 경로라 번들러 밖(node 직접 실행)에서는 아예 못 찾는다.
export type * from './types';

/** 앱에 복사할 때 이 값을 복사본 주석에 남긴다 — 서버 계약이 바뀌었는지 판단하는 유일한 단서다. */
export const SDK_VERSION = '2026-08-10';

const DEFAULT_TIMEOUT_MS = 10000;
/** 서버가 요구하는 문의 최소 길이(라우트의 CONTENT_MIN과 같은 값). */
export const CONTENT_MIN = 5;
/** 서버가 자르는 상한. 입력창 maxLength를 이보다 크게 두지 않는다. */
export const CONTENT_MAX = 2000;

export function createCommonServer(cfg: CommonServerConfig) {
  const baseUrl = (cfg.baseUrl ?? '').replace(/\/$/, '');
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const storage = cfg.storage ?? null;
  // 앱 코드를 키에 넣는다 — 서버는 1배포 N앱이고, 토큰에도 app이 박혀 있어 앱 간에 재사용되지 않는다.
  const storageKey = `cs_session_${cfg.appCode}`;

  let token: string | null = null;
  let subject: Subject | null = null;

  /** 응답 없이 매달리지 않도록 타임아웃을 건다(사용자가 로딩에 갇히는 것 방지). */
  async function req(path: string, init?: RequestInit, withAuth = false): Promise<Response | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers: Record<string, string> = { ...((init?.headers as Record<string, string>) ?? {}) };
    // 토큰이 없으면 헤더를 붙이지 않는다. 서버는 **헤더가 있는데 무효면 401**이고 익명으로 강등하지 않는다
    // (강등하면 로그인 사용자의 문의가 귀속 없이 저장돼 답변을 영영 못 받는다).
    if (withAuth && token) headers.authorization = `Bearer ${token}`;
    try {
      return await fetch(`${baseUrl}${path}`, { ...init, headers, signal: controller.signal });
    } catch {
      return null; // fetch 실패·abort는 모두 "지금은 못 함"으로 묶는다 — 사용자가 할 일은 같다(나중에 재시도)
    } finally {
      clearTimeout(timer);
    }
  }

  const mapFail = (status: number) =>
    status === 429
      ? ('rate-limited' as const)
      : status === 404
        ? ('not-found' as const)
        : status === 401
          ? ('unauthorized' as const)
          : status === 503
            ? ('not-configured' as const) // 서버에 세션 시크릿이 없다 — 앱 잘못이 아니고 재시도 가능
            : ('error' as const);

  /** 메모리와 저장소의 토큰을 함께 옮긴다. 저장 실패로 로그인 자체를 실패시키지는 않는다. */
  async function setSession(next: string | null, who: Subject | null) {
    token = next;
    subject = who;
    if (!storage) return;
    try {
      if (next) await storage.setItem(storageKey, next);
      else await storage.removeItem(storageKey);
    } catch {
      // 이번 실행 동안은 메모리 토큰으로 계속 동작한다 — 다음 실행에서 다시 로그인하면 된다
    }
  }

  /** 저장소에 있던 토큰을 메모리로 끌어올린다(최초 1회). */
  async function loadToken(): Promise<string | null> {
    if (token || !storage) return token;
    try {
      token = (await storage.getItem(storageKey)) ?? null;
    } catch {
      token = null;
    }
    return token;
  }

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

    /**
     * 문의 접수.
     *
     * 로그인 상태면 자동으로 세션을 실어 **본인 문의로 귀속**되고(답변을 받을 수 있다),
     * 아니면 익명 단방향으로 접수된다. 호출부는 구분할 필요가 없다.
     *
     * 세션이 만료됐다면 'unauthorized'로 떨어지고 세션은 폐기된다. 이때 **본문을 지우지 말 것** —
     * 다시 로그인시키거나 익명으로 재시도할 수 있게 화면에 남겨둬야 한다.
     */
    async sendInquiry(category: SupportCategory, content: string): Promise<Result<{}>> {
      const trimmed = content.trim();
      if (trimmed.length < CONTENT_MIN) return { ok: false, reason: 'too-short' };
      if (!baseUrl) return { ok: false, reason: 'not-configured' };
      await loadToken();

      const res = await req(
        '/api/v1/tickets',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            app: cfg.appCode,
            category,
            content: trimmed,
            device: { platform: cfg.platform, appVersion: cfg.appVersion },
          }),
        },
        true,
      );
      if (!res) return { ok: false, reason: 'offline' };
      if (res.ok) return { ok: true };
      if (res.status === 401) await setSession(null, null); // 죽은 토큰을 들고 계속 재시도하지 않는다
      return { ok: false, reason: mapFail(res.status) };
    },

    // ───────────────────────── 로그인 ─────────────────────────

    /**
     * 소셜 로그인 → 우리 세션 발급.
     *
     * ⚠ idToken은 **앱이** 공급자 SDK로 받아온다(이 모듈은 의존성 0이라 구글 로그인을 직접 못 한다).
     *   Expo면 `@react-native-google-signin/google-signin`의 `signIn()` 결과에서 꺼낸다.
     *
     * ⚠ 안드로이드·iOS 네이티브 로그인이어도 idToken은 **웹 클라이언트 ID**로 발급된다.
     *   구글 콘솔의 webClientId를 SDK에 넘기고, 서버(관리자 콘솔 → 소셜 로그인)의 audience에도
     *   그 웹 클라이언트 ID를 반드시 포함시켜야 한다. 빠뜨리면 전부 'unauthorized'로만 보인다.
     *
     * 서버는 실패 사유를 뭉갠다(설정 탐색 방지). 'unauthorized'가 곧 "토큰이 틀렸다"는 뜻은 아니고,
     * 그 앱에 공급자가 설정되지 않았을 때도 같은 값이 온다 — 진단은 관리자 콘솔에서 한다.
     */
    async login(provider: AuthProviderId, idToken: string): Promise<Result<{ subject: Subject }>> {
      if (!baseUrl) return { ok: false, reason: 'not-configured' };
      if (!idToken) return { ok: false, reason: 'unauthorized' };

      const res = await req('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app: cfg.appCode, provider, idToken }),
      });
      if (!res) return { ok: false, reason: 'offline' };
      if (!res.ok) return { ok: false, reason: mapFail(res.status) };
      try {
        const j = (await res.json()) as { token?: string; subject?: Subject };
        if (!j.token || !j.subject) return { ok: false, reason: 'error' };
        await setSession(j.token, j.subject);
        return { ok: true, subject: j.subject };
      } catch {
        return { ok: false, reason: 'error' };
      }
    },

    /**
     * 저장된 세션을 되살린다. 앱 부팅 시 1회 호출.
     *
     * ⚠ 'offline'일 때 세션을 지우지 않는다. 지하철에서 앱을 켰다고 로그아웃되면 안 된다 —
     *   세션 폐기는 서버가 **401로 명시적으로 거절했을 때만** 한다.
     */
    async restoreSession(): Promise<Result<{ subject: Subject }>> {
      if (!baseUrl) return { ok: false, reason: 'not-configured' };
      if (!(await loadToken())) return { ok: false, reason: 'not-signed-in' };

      const res = await req('/api/v1/auth/me', undefined, true);
      if (!res) return { ok: false, reason: 'offline' };
      if (res.status === 401) {
        await setSession(null, null);
        return { ok: false, reason: 'unauthorized' };
      }
      if (!res.ok) return { ok: false, reason: mapFail(res.status) };
      try {
        const j = (await res.json()) as { subject?: Subject };
        if (!j.subject) return { ok: false, reason: 'error' };
        subject = j.subject;
        return { ok: true, subject: j.subject };
      } catch {
        return { ok: false, reason: 'error' };
      }
    },

    /** 마지막으로 확인된 "나". login/restoreSession 이후에만 채워진다. */
    getSubject(): Subject | null {
      return subject;
    },

    /** 이 기기에 세션이 있는지. 유효한지는 아니다 — 그건 restoreSession()이 판단한다. */
    async isSignedIn(): Promise<boolean> {
      return (await loadToken()) !== null;
    },

    /**
     * 로그아웃 — 이 기기의 세션만 지운다.
     * 서버 토큰은 무상태(서명 검증)라 서버 쪽에 폐기 목록이 없다. 기기를 잃어버린 경우의 대비는 탈퇴다.
     */
    async logout(): Promise<void> {
      await setSession(null, null);
    },

    /**
     * 탈퇴(계정 삭제). **Google Play 정책상 앱 안에 이 경로가 있어야 한다.**
     * 서버는 행을 지우지 않고 가명화한다 — 문의는 보관기간(3년) 동안 남지만 작성자를 되짚을 수 없다.
     * 성공하면 로컬 세션도 함께 지운다(같은 토큰으로 되살아나면 안 된다).
     */
    async deleteAccount(): Promise<Result<{}>> {
      if (!baseUrl) return { ok: false, reason: 'not-configured' };
      if (!(await loadToken())) return { ok: false, reason: 'not-signed-in' };

      const res = await req('/api/v1/auth/me', { method: 'DELETE' }, true);
      if (!res) return { ok: false, reason: 'offline' };
      if (res.ok || res.status === 401) {
        // 401도 세션을 지운다 — 이미 무효한 토큰을 붙들고 있을 이유가 없다
        await setSession(null, null);
      }
      return res.ok ? { ok: true } : { ok: false, reason: mapFail(res.status) };
    },

    /**
     * 내 엔타이틀먼트(구독). 미구독자도 성공하고 `{}`가 온다 — 서버 오류와 구분되어야 한다.
     * 그 차이가 **광고를 띄울지 말지**를 가른다.
     *
     * ⚠ 오프라인 대비로 앱이 캐시할 때는 `expiresAt`을 함께 저장하고 그때까지만 유효로 볼 것.
     *   `active`만 캐시하면 만료된 뒤에도 영원히 pro가 된다.
     *
     * ⚠ 로그인했는데 active가 false라면 스토어에 구독이 남아 있을 수 있다(탈퇴 후 재가입 등으로
     *   subject가 바뀐 경우). 그때 `Purchases.restorePurchases()`를 부르면 RC가 소유자를 옮기고
     *   서버에 TRANSFER 웹훅이 온다. 안 부르면 "돈은 나가는데 pro가 아닌" 상태가 유지된다.
     */
    async fetchEntitlements(): Promise<Result<{ entitlements: Record<string, EntitlementView>; checkedAt: string }>> {
      if (!baseUrl) return { ok: false, reason: 'not-configured' };
      if (!(await loadToken())) return { ok: false, reason: 'not-signed-in' };

      const res = await req('/api/v1/entitlements', undefined, true);
      if (!res) return { ok: false, reason: 'offline' };
      if (res.status === 401) {
        await setSession(null, null);
        return { ok: false, reason: 'unauthorized' };
      }
      if (!res.ok) return { ok: false, reason: mapFail(res.status) };
      try {
        const j = (await res.json()) as { entitlements?: Record<string, EntitlementView>; checkedAt?: string };
        return { ok: true, entitlements: j.entitlements ?? {}, checkedAt: j.checkedAt ?? new Date().toISOString() };
      } catch {
        return { ok: false, reason: 'error' };
      }
    },

    /**
     * 내 문의와 답변. 이게 로그인의 존재 이유다.
     * reply가 채워져 있으면 운영자 답변이고, 그대로 화면에 보여주면 된다.
     */
    async fetchMyInquiries(): Promise<Result<{ inquiries: MyInquiry[] }>> {
      if (!baseUrl) return { ok: false, reason: 'not-configured' };
      if (!(await loadToken())) return { ok: false, reason: 'not-signed-in' };

      const res = await req('/api/v1/tickets/mine', undefined, true);
      if (!res) return { ok: false, reason: 'offline' };
      if (res.status === 401) {
        await setSession(null, null);
        return { ok: false, reason: 'unauthorized' };
      }
      if (!res.ok) return { ok: false, reason: mapFail(res.status) };
      try {
        const j = (await res.json()) as { tickets?: MyInquiry[] };
        return { ok: true, inquiries: j.tickets ?? [] };
      } catch {
        return { ok: false, reason: 'error' };
      }
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
