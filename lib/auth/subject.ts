// 주체(subject) 해석·생성 — 로그인 라우트와 인증이 필요한 공개 라우트가 공유한다.
import crypto from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { appAuthProviders, subjects, type Subject } from '../../db/schema';
import { sessionFromRequest } from './session';

/** 앱의 공급자 설정(활성 + audience 목록). 없거나 꺼져 있으면 null → 로그인 거부. */
export async function providerConfig(appCode: string, provider: string): Promise<string[] | null> {
  const rows = await db
    .select()
    .from(appAuthProviders)
    .where(and(eq(appAuthProviders.appCode, appCode), eq(appAuthProviders.provider, provider)))
    .limit(1);
  const row = rows[0];
  if (!row || !row.enabled) return null;
  const list = row.audiences
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : null; // 빈 목록 = 검증 불가 → 통과시키지 않는다
}

/**
 * 로그인 시 주체 확보. 같은 (앱, 공급자, providerId)면 기존 행을 재사용하고 이메일·접속시각만 갱신한다.
 * 이메일은 공급자가 줄 때만 갱신한다 — 한 번 받은 뒤 안 주는 응답이 와도 기존 값을 지우지 않는다.
 */
export async function ensureSubject(
  appCode: string,
  provider: string,
  providerId: string,
  email: string | null,
): Promise<Subject> {
  const now = new Date();
  const inserted = await db
    .insert(subjects)
    .values({ appCode, kind: 'user', provider, providerId, email, lastSeenAt: now })
    .onConflictDoUpdate({
      target: [subjects.appCode, subjects.provider, subjects.providerId],
      set: { lastSeenAt: now, ...(email ? { email } : {}) },
    })
    .returning();
  return inserted[0];
}

export interface Authed {
  subject: Subject;
}

/**
 * 요청의 세션 토큰 → 살아있는 주체. 없거나 무효·탈퇴면 null(→401).
 *
 * 토큰의 app과 주체의 app이 **둘 다** 맞아야 한다. 토큰에만 app을 담고 대조하지 않으면
 * A앱 토큰으로 B앱 데이터를 조회할 수 있다.
 */
export async function requireSubject(req: Request): Promise<Authed | null> {
  const claims = sessionFromRequest(req);
  if (!claims) return null;
  const rows = await db.select().from(subjects).where(eq(subjects.id, claims.sid)).limit(1);
  const s = rows[0];
  if (!s || s.deletedAt) return null; // 탈퇴한 주체의 옛 토큰으로 부활시키지 않는다
  if (s.appCode !== claims.app) return null;
  return { subject: s };
}

/**
 * 탈퇴 — 소프트삭제 + **가명화**.
 *
 * 행을 지우지 않는 이유: 문의가 subject_id로 이 행을 참조하고, 문의는 보관기간(3년) 동안 남아야 한다.
 * 대신 개인정보(이메일)를 지우고 provider_id를 토움스톤으로 바꾼다 —
 * 그래야 UNIQUE가 풀려 같은 계정으로 다시 가입할 수 있고, 옛 세션 토큰으로도 부활하지 않는다.
 */
export async function softDeleteSubject(id: string): Promise<void> {
  await db
    .update(subjects)
    .set({
      deletedAt: new Date(),
      email: null,
      providerId: `deleted:${crypto.randomUUID()}`,
    })
    .where(eq(subjects.id, id));
}
