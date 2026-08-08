// 세션 토큰 — 자체 HS256 미니 JWT(외부 의존성 0, node:crypto).
//
// 왜 자체 토큰인가: 구글 ID 토큰은 1시간이면 만료되고, 매 요청마다 구글에 재검증하는 건 느리고 취약하다.
// 로그인 시 **한 번만** 공급자 토큰을 검증하고, 그 뒤로는 우리가 서명한 토큰으로 주체를 식별한다.
//
// **fail-closed**: 프로덕션에서 SESSION_JWT_SECRET이 없거나 32자 미만이면 발급도 검증도 거부한다.
// 약한 키를 허용하면 토큰을 위조해 **남의 계정으로 문의를 조회**할 수 있다.
// env는 호출 시점에 읽는다 — 모듈 로드 시 캐시하면 배포 env 변경에 반응하지 못한다.
import crypto from 'node:crypto';

const MIN_SECRET_LEN = 32;
const TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180일 — 앱을 자주 안 여는 사용자가 갑자기 로그아웃되지 않게 관대하게

const b64 = (v: Buffer | string): string => Buffer.from(v as Buffer).toString('base64url');

function isProd(): boolean {
  return process.env.VERCEL_ENV === 'production' || process.env.VERCEL_ENV === 'preview';
}

/** 서명에 쓸 시크릿. 없거나 짧으면 null(= 기능 전면 차단). 로컬은 짧아도 경고만 하고 통과시키지 않는다 —
 *  로컬에서만 되는 인증은 "된다"는 착각을 만들어 배포 후에야 터진다. */
function secret(): string | null {
  const s = process.env.SESSION_JWT_SECRET ?? '';
  if (s.length < MIN_SECRET_LEN) return null;
  return s;
}

/** 세션 기능을 쓸 수 있는 환경인가. 라우트가 503/501을 돌려줄지 판단할 때 쓴다. */
export function sessionReady(): boolean {
  return secret() !== null;
}

const hmac = (body: string, key: string): string => b64(crypto.createHmac('sha256', key).update(body).digest());

export interface SessionClaims {
  /** subjects.id */
  sid: string;
  /** app_code — 토큰이 다른 앱에서 재사용되는 것을 막는다 */
  app: string;
}

/** 세션 토큰 발급. 시크릿이 없으면 null(fail-closed). */
export function signSession(claims: SessionClaims): string | null {
  const key = secret();
  if (!key) return null;
  const body = b64(JSON.stringify({ ...claims, iat: Date.now() }));
  return `${body}.${hmac(body, key)}`;
}

/** 토큰 검증 → claims. 위조·변조·만료·시크릿 미설정이면 null. 상수시간 비교. */
export function verifySession(token: string): SessionClaims | null {
  const key = secret();
  if (!key) return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = hmac(body, key);
  // 길이가 다르면 timingSafeEqual이 throw하므로 먼저 거른다(길이 노출은 위조에 도움이 안 된다)
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (typeof p.sid !== 'string' || typeof p.app !== 'string') return null;
    if (typeof p.iat !== 'number' || Date.now() - p.iat > TOKEN_TTL_MS) return null;
    return { sid: p.sid, app: p.app };
  } catch {
    return null;
  }
}

/** 요청의 `Authorization: Bearer <세션토큰>` → claims. 없거나 무효면 null. */
export function sessionFromRequest(req: Request): SessionClaims | null {
  const auth = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? verifySession(m[1].trim()) : null;
}

/** 프로덕션에서 시크릿이 준비됐는지 — 가드·health가 설정 누락을 조기에 잡는다. */
export function sessionConfigNote(): string | null {
  if (secret()) return null;
  return isProd()
    ? 'SESSION_JWT_SECRET 미설정/32자 미만 — 로그인 기능 전면 차단됨'
    : 'SESSION_JWT_SECRET 미설정 — 로컬에서도 로그인은 동작하지 않는다';
}
