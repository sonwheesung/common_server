// 최초 시드 — 앱 1개 등록(+ settings 행). 관리자 콘솔이 뜨기 전에 DB를 쓸 수 있게 하는 부트스트랩 스크립트.
//
// 실행:
//   node --env-file=.env.local tools/seed.ts myword "My Word"
//
// 멱등하다 — 여러 번 돌려도 기존 행을 건드리지 않는다(onConflictDoNothing).
//
// db/index.ts 를 재사용하지 않고 자체 연결을 연다: 그쪽은 `./schema`를 확장자 없이 import하는데
// (Next/Turbopack은 해석하지만) 순수 node ESM은 확장자를 요구한다. 런타임 코드를 도구 사정으로
// 바꾸지 않으려고 여기서 연결을 소유한다. 스크립트는 짧게 살고 바로 끊으므로 풀도 1이면 충분하다.
export {};

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { apps, appSettings } from '../db/schema.ts';

const appCode = (process.argv[2] ?? '').trim().toLowerCase();
const name = (process.argv[3] ?? '').trim();

if (!/^[a-z0-9_]{2,64}$/.test(appCode) || !name) {
  console.error('usage: node --env-file=.env.local tools/seed.ts <app_code> "<표시 이름>"');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL 이 없습니다. --env-file=.env.local 을 붙였는지 확인하세요.');
  process.exit(1);
}

const client = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const db = drizzle(client);

await db.transaction(async (tx) => {
  await tx.insert(apps).values({ appCode, name }).onConflictDoNothing({ target: apps.appCode });
  await tx.insert(appSettings).values({ appCode }).onConflictDoNothing({ target: appSettings.appCode });
});

const rows = await db.select().from(apps);
console.log('등록된 앱:');
for (const r of rows) console.log(`  ${r.appCode} — ${r.name} (active=${r.active}, 문의 24h 캡=${r.ticketDailyCap})`);

await client.end();
