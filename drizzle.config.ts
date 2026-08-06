import type { Config } from 'drizzle-kit';

// 마이그레이션은 Session/Direct(:5432) 문자열로 돌린다 — Transaction 풀러(:6543)는 DDL에 부적합.
//   DATABASE_URL="postgresql://...:5432/postgres" npm run db:push
export default {
  schema: './db/schema.ts',
  out: './db/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
} satisfies Config;
