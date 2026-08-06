// .env.local 의 DB_PASSWORD(원문) → DATABASE_URL / DATABASE_URL_MIGRATE 로 조립하고 원문 줄은 지운다.
//
// 왜 이런 방식인가:
//   · 비밀번호에 @ : / ? # [ ] & 가 있으면 URL 파싱이 깨진다. 손으로 percent-encode 하다 틀리면
//     "호스트가 이상하다"거나 "인증 실패" 같은 엉뚱한 증상으로 나타나 원인을 찾기 어렵다 → 기계가 인코딩한다.
//   · 원문을 셸 인자나 환경변수로 받지 않는다(명령 히스토리·프로세스 목록에 남지 않게).
//   · 조립 후 DB_PASSWORD 줄을 제거해 원문이 파일에 남지 않게 한다.
//
// 사용:
//   1) .env.local 에  DB_PASSWORD=여기에원문  한 줄 추가
//   2) node tools/_setup_env.ts
export {};

import { readFileSync, writeFileSync } from 'node:fs';

const ENV_PATH = new URL('../.env.local', import.meta.url);
const HOST = 'aws-0-ap-northeast-2.pooler.supabase.com';
const USER = 'postgres.nhpnvwwhuyvwcmkkhayc';

const raw = readFileSync(ENV_PATH, 'utf8');
const lines = raw.split(/\r?\n/);

const idx = lines.findIndex((l) => /^\s*DB_PASSWORD\s*=/.test(l));
if (idx < 0) {
  console.error('.env.local 에 DB_PASSWORD=<원문> 줄이 없습니다.');
  process.exit(1);
}

// '=' 이후 전부가 비밀번호다(비밀번호에 '=' 가 있어도 안전). 감싼 따옴표만 벗긴다.
let pw = lines[idx].slice(lines[idx].indexOf('=') + 1).trim();
if ((pw.startsWith('"') && pw.endsWith('"')) || (pw.startsWith("'") && pw.endsWith("'"))) pw = pw.slice(1, -1);
if (!pw || pw === '[PASSWORD]') {
  console.error('DB_PASSWORD 가 비어 있거나 placeholder 입니다.');
  process.exit(1);
}

const enc = encodeURIComponent(pw);
const url = (port: number) => `postgresql://${USER}:${enc}@${HOST}:${port}/postgres`;

const set = (key: string, value: string) => {
  const i = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (i >= 0) lines[i] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
};

set('DATABASE_URL', url(6543)); // 런타임 — Transaction 풀러
set('DATABASE_URL_MIGRATE', url(5432)); // 마이그레이션 — Session 풀러(DDL)

lines.splice(idx, 1); // 원문 제거
writeFileSync(ENV_PATH, lines.join('\n'), 'utf8');

console.log(`DATABASE_URL 조립 완료 (host=${HOST})`);
console.log(`  비밀번호 ${pw.length}자 → percent-encode 후 ${enc.length}자${enc === pw ? ' (특수문자 없음)' : ' (특수문자 인코딩됨)'}`);
console.log('  DB_PASSWORD 원문 줄은 .env.local 에서 제거했습니다.');
