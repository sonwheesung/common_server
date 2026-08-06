// 공통 서버 클라이언트 SDK — 타입.
//
// 이 폴더는 각 앱의 `src/services/commonServer/`로 **복사해서** 쓴다(앱 4~5개 규모에선 monorepo·npm 패키지
// 오버헤드가 이득보다 크다). 복사본에는 어느 버전에서 가져왔는지 주석을 남긴다.
// 의존성 0 — react-native를 import하지 않으므로 Expo·웹·Node 어디서나 그대로 돈다.

export type SupportCategory = 'bug' | 'suggestion' | 'question' | 'etc';

export type FailReason =
  | 'not-configured' // 서버 URL이 빌드에 안 박힌 상태
  | 'offline' // 네트워크 불가 / 타임아웃
  | 'too-short' // 본문이 최소 길이 미만
  | 'rate-limited' // 접수 한도 초과
  | 'not-found' // 앱 미등록/비활성 (서버에 app_code가 없음)
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
}
