// DB 클라이언트 싱글턴 — Next dev의 HMR이 매번 새 풀을 열지 않게 globalThis에 캐시.
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

// 미설정이어도 **모듈 로드 시 throw하지 않는다** — 빌드/스캐폴드가 DB 없이도 통과해야 하므로.
// 연결은 첫 쿼리 때 시도되고, 실패는 /api/health 가 db:"down" 으로 보고한다.
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/postgres';

const g = globalThis as unknown as { __pg?: ReturnType<typeof postgres> };
// prepare:false — Supabase Transaction 풀러(:6543, PgBouncer transaction 모드)는 prepared statement 미지원이라 필수.
// Direct/Session 연결에서도 무해하므로 무조건 켠다(항상 안전한 기본값).
const client = g.__pg ?? postgres(DATABASE_URL, { max: 10, prepare: false });
if (process.env.NODE_ENV !== 'production') g.__pg = client;

export const db = drizzle(client, { schema });
export { client, schema };

/** DATABASE_URL 이 실제로 설정됐는가(기본 폴백이 아닌가). health/가드가 "미설정"과 "설정했는데 다운"을 구분하는 데 쓴다. */
export const dbConfigured = (): boolean => Boolean(process.env.DATABASE_URL);
