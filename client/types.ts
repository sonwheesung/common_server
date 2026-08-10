// 공통 서버 클라이언트 SDK — 타입.
//
// 이 폴더는 각 앱의 `src/services/commonServer/`로 **복사해서** 쓴다(앱 4~5개 규모에선 monorepo·npm 패키지
// 오버헤드가 이득보다 크다). 복사본에는 어느 버전에서 가져왔는지 주석을 남긴다.
// 의존성 0 — react-native를 import하지 않으므로 Expo·웹·Node 어디서나 그대로 돈다.

export type SupportCategory = 'bug' | 'suggestion' | 'question' | 'etc';

export type FailReason =
  | 'not-configured' // 서버 URL이 빌드에 안 박혔거나, 서버가 로그인을 아직 못 여는 상태(503)
  | 'offline' // 네트워크 불가 / 타임아웃
  | 'too-short' // 본문이 최소 길이 미만
  | 'rate-limited' // 접수 한도 초과
  | 'not-found' // 앱 미등록/비활성 (서버에 app_code가 없음)
  | 'unauthorized' // 로그인 실패 / 세션 만료·무효 (세션은 이 시점에 폐기된다)
  | 'not-signed-in' // 로컬에 세션이 없음 — 서버에 물어보지도 않은 상태
  | 'error'; // 서버 오류

export type Result<T> = ({ ok: true } & T) | { ok: false; reason: FailReason };

export interface AnnouncementItem {
  id: string;
  kind: string; // notice | event | update
  title: string;
  body: string;
  pinned: boolean;
  startsAt: string; // ISO — 앱에서 "등록일"로 표시
}

export interface Bootstrap {
  maintenance: { active: false } | { active: true; title: string; body: string };
  version: {
    min: string | null; // 이 미만 = 강제 업데이트(진입 차단)
    latest: string | null; // 이 미만 = 소프트 안내
    androidUrl: string | null;
    iosUrl: string | null;
  };
  announcements: AnnouncementItem[];
}

// ───────────────────────── 로그인 ─────────────────────────

/** 지금 서버가 검증할 수 있는 공급자. kakao·apple은 서버에 검증기가 붙는 시점에 열린다. */
export type AuthProviderId = 'google' | 'kakao' | 'apple';

/** 우리 서버가 아는 "나". providerId(구글 sub 등)는 앱에 내려주지 않는다. */
export interface Subject {
  id: string;
  email: string | null; // 공급자가 email_verified로 확인해 준 주소만 채워진다
  provider?: string;
  createdAt?: string;
}

export interface MyInquiry {
  id: string;
  category: SupportCategory;
  content: string;
  status: 'open' | 'replied' | 'resolved';
  /** 운영자 답변. 이게 로그인의 존재 이유다(익명 문의는 돌려줄 경로가 없다). */
  reply: string | null;
  createdAt: string;
  repliedAt: string | null;
}

/** 엔타이틀먼트(구독) 상태. 서버가 계산해서 내려준다 — 앱이 만료를 다시 판정하지 않는다. */
export interface EntitlementView {
  active: boolean;
  /** ISO. 오프라인 캐시의 유효기한이다. 유예 중이면 유예 종료 시각이 온다. */
  expiresAt: string | null;
  willRenew: boolean;
  /** 결제 실패 유예 중. 활성이지만 곧 끊길 수 있어 안내를 띄울 수 있다. */
  inGracePeriod: boolean;
}

/**
 * 세션 토큰을 앱 재실행 후에도 유지하려면 저장소를 넘긴다.
 * SDK는 의존성 0을 지켜야 해서 AsyncStorage를 직접 import하지 않는다 — 앱이 주입한다.
 *
 *   import AsyncStorage from '@react-native-async-storage/async-storage';
 *   createCommonServer({ ..., storage: AsyncStorage })
 *
 * 넘기지 않으면 세션은 **메모리에만** 산다(앱을 껐다 켜면 다시 로그인해야 한다).
 */
export interface SessionStorage {
  getItem(key: string): Promise<string | null> | string | null;
  setItem(key: string, value: string): Promise<void> | void;
  removeItem(key: string): Promise<void> | void;
}

export interface CommonServerConfig {
  /** EXPO_PUBLIC_SERVER_URL 등. 빈 문자열이면 모든 호출이 'not-configured'로 떨어진다. */
  baseUrl: string;
  /** 서버 `apps` 테이블에 등록된 코드. */
  appCode: string;
  /** 앱 버전 — 진단·버전 게이트 비교용. */
  appVersion: string;
  /** 'ios' | 'android' | 'web' — RN이면 Platform.OS를 넘긴다(SDK는 RN에 의존하지 않는다). */
  platform: string;
  /** 기본 10초. */
  timeoutMs?: number;
  /** 세션 영속화. 없으면 메모리 전용 — 로그인 없는 앱은 넘기지 않아도 된다. */
  storage?: SessionStorage;
}
