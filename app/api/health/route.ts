// GET /api/health — 배포 확인용. DB 왕복 1회로 연결 상태까지 본다.
// 인증 없음(운영 정보를 흘리지 않도록 응답은 최소치만 — 에러 메시지·연결 문자열은 절대 노출하지 않는다).
import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { db, dbConfigured } from '../../../db';

export const dynamic = 'force-dynamic';

export async function GET() {
  let dbState: 'up' | 'down' | 'unset' = dbConfigured() ? 'down' : 'unset';
  if (dbConfigured()) {
    try {
      await db.execute(sql`select 1`);
      dbState = 'up';
    } catch {
      dbState = 'down'; // 사유는 응답에 싣지 않는다(내부 구조 노출 회피). 상세는 Sentry/로그로.
    }
  }
  return NextResponse.json({ ok: dbState === 'up', db: dbState, now: new Date().toISOString() });
}
