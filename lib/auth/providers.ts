// 소셜 로그인 공급자 검증 — **레지스트리**.
//
// 지금은 구글만 구현돼 있고, 카카오·애플이 뒤에 온다. 그때 할 일은 검증 함수 하나를 쓰고
// VERIFIERS에 한 줄 등록하는 것뿐이다. 라우트·스키마·세션은 손대지 않는다.
//
// ★ 안전 원칙: **구현된 검증기가 있는 공급자만 허용한다.** 미구현 공급자는 설정에서 켜져 있어도 거부한다.
//   "일단 클라가 준 providerId를 믿고 나중에 검증 붙이자"는 곧 **아무나 남의 계정으로 로그인**이다.
//   배구 서버가 애플을 이 방식으로 막아둔 덕에 미검증 로그인이 프로덕션에 나가지 않았다.

export interface Identity {
  /** 공급자 고유 식별자(구글 sub 등) */
  providerId: string;
  /** 검증된 이메일. 공급자가 안 줄 수도 있다 */
  email: string | null;
}

/** audiences: 앱별로 등록된 클라이언트 ID 목록(콤마 구분 문자열을 배열로 파싱해 넘긴다). */
export type Verifier = (token: string, audiences: string[]) => Promise<Identity | null>;

/**
 * 구글 ID 토큰 검증 — 서명(JWKS) · audience · 만료를 google-auth-library가 처리한다.
 *
 * audience가 왜 중요한가: 서명만 맞으면 **다른 서비스용으로 발급된 구글 토큰**도 통과한다.
 * 우리 클라이언트 ID로 발급된 토큰인지 확인해야 남의 앱 토큰을 우리 서버에 들이미는 걸 막는다.
 * 그래서 audiences가 비면 검증 불가로 보고 null(fail-closed) — "검증 없이 통과"는 절대 없다.
 *
 * ⚠ 안드로이드/iOS 네이티브 구글 로그인은 보통 **웹 클라이언트 ID**로 idToken을 발급한다.
 *   audiences에 웹 클라이언트 ID를 빠뜨리면 "설정은 다 했는데 로그인이 안 되는" 상태가 된다.
 */
const verifyGoogle: Verifier = async (token, audiences) => {
  if (!token || audiences.length === 0) return null;
  try {
    // 지연 import — 구글을 안 쓰는 배포에서 모듈을 아예 안 만진다
    const { OAuth2Client } = await import('google-auth-library');
    const client = new OAuth2Client();
    const ticket = await client.verifyIdToken({ idToken: token, audience: audiences });
    const p = ticket.getPayload();
    if (!p?.sub) return null;
    // 이메일은 **검증된 것만** 받는다. email_verified가 false면 그 주소의 소유가 증명되지 않았다.
    const email = p.email && p.email_verified ? p.email : null;
    return { providerId: p.sub, email };
  } catch {
    return null; // 서명 불일치·만료·audience 불일치 — 모두 "로그인 실패" 하나로 묶는다(사유를 알려주지 않는다)
  }
};

/** 구현된 검증기만 여기 있다. 카카오·애플은 구현 시 추가한다. */
const VERIFIERS: Record<string, Verifier> = {
  google: verifyGoogle,
  // kakao: verifyKakao,   ← OIDC ID토큰 방식 권장(aud로 앱 귀속이 자동 확인된다).
  //                          access token + /v2/user/me 방식을 쓸 거면 app_id를 반드시 따로 대조해야 한다
  //                          — 안 하면 **다른 카카오 앱의 토큰**이 우리 서버에서 통한다(confused deputy).
  // apple: verifyApple,   ← JWKS(appleid.apple.com) + aud=bundle id. 이름은 최초 인증 때만 오므로 그때 저장해야 한다.
};

/** 이 공급자를 지금 받아줄 수 있는가(검증기 구현 여부). */
export const isProviderSupported = (provider: string): boolean => provider in VERIFIERS;

/** 지원 공급자 목록 — 관리자 콘솔이 "설정 가능한 공급자"를 보여줄 때 쓴다. */
export const SUPPORTED_PROVIDERS = Object.keys(VERIFIERS);

/** 공급자 토큰 → 신원. 미지원 공급자·검증 실패는 모두 null. throw 없음. */
export async function verifyProviderToken(provider: string, token: string, audiences: string[]): Promise<Identity | null> {
  const v = VERIFIERS[provider];
  if (!v) return null; // 미구현 공급자는 설정이 켜져 있어도 거부(fail-closed)
  return v(token, audiences);
}
