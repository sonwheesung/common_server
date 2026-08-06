// 관리자 인증 — **fail-closed**.
// 크론의 fail-open("시크릿 미설정 시 통과")을 여기 복제하면 재앙이다(env 누락 = 누구나 공지 발행·문의 열람).
// → ADMIN_TOKEN이 없거나 짧으면(<16자) 무조건 거부. Bearer 헤더 방식이라 CSRF 내성(쿠키 인증 미도입).
import { timingSafeEqual } from 'node:crypto';

const MIN_TOKEN_LEN = 16;

/** Authorization: Bearer <ADMIN_TOKEN> 상수시간 검증. 토큰 미설정/짧으면 항상 false(전면 거부). */
export function isAdmin(req: Request): boolean {
  const token = process.env.ADMIN_TOKEN ?? ''; // 호출 시점 읽기 — 모듈 로드 시 캐시하면 배포 env 변경에 반응 못 함
  if (token.length < MIN_TOKEN_LEN) return false; // fail-closed
  const auth = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false; // timingSafeEqual은 동일 길이 요구
  return timingSafeEqual(a, b);
}
