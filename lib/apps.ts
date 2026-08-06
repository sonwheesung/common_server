// 앱 해석 — 공개 라우트의 allowlist. 배구는 env(ANON_TICKET_PROJECTS)였지만 여기선 `apps` 테이블이 근거다
// (앱을 하나 늘릴 때마다 재배포하지 않기 위해). 미등록/비활성은 **404**로 응답한다 — 존재 여부를 알려주지 않는다.
//
// 캐시를 두지 않는다: `active` 토글과 점검(maintenance) 플래그는 사고 시 **즉시** 먹어야 하는 스위치라,
// 몇십 초짜리 캐시가 "껐는데 왜 안 꺼지지"를 만든다. 부팅 조회는 어차피 앱당 실행 1회 수준이다.
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { apps, type App } from '../db/schema';

/** 요청에서 온 app 코드 정규화 — trim + 소문자. 저장·조회 모두 이 정규형 기준. */
export const normalizeAppCode = (raw: unknown): string =>
  typeof raw === 'string' ? raw.trim().toLowerCase().slice(0, 64) : '';

/** 등록되고 활성인 앱이면 행, 아니면 null. 공개 라우트는 null이면 무조건 404. */
export async function getActiveApp(rawCode: unknown): Promise<App | null> {
  const code = normalizeAppCode(rawCode);
  if (!code) return null;
  const rows = await db.select().from(apps).where(eq(apps.appCode, code)).limit(1);
  const app = rows[0];
  return app && app.active ? app : null;
}
