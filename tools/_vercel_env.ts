// .env.local 의 선택된 키를 Vercel 프로젝트 환경변수(production)로 밀어넣는다.
//
// 왜 스크립트인가: `vercel env add` 는 값을 stdin 으로 받는데, 셸 파이프(PowerShell 포함)는 값 끝에
// 개행을 붙인다. DATABASE_URL 에 개행이 하나 붙으면 "인증 실패"로만 보이고 원인을 찾기 어렵다.
// 여기서는 자식 프로세스 stdin 에 **정확한 바이트만** 쓰고 닫는다.
//
// 사용: node tools/_vercel_env.ts [--target production|preview]
export {};

import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

// 배포에 필요한 것만. 빈 값(Upstash·Discord·Sentry 미설정)은 자동으로 건너뛴다 —
// 빈 문자열을 올리면 "설정됨"으로 보여서 fail-open/no-op 판단이 흐려진다.
const KEYS = ['DATABASE_URL', 'ADMIN_TOKEN', 'CRON_SECRET', 'SESSION_JWT_SECRET', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'DISCORD_TICKET_WEBHOOK_URL', 'DISCORD_TICKET_WEBHOOK_URL_MYWORD', 'DISCORD_TICKET_WEBHOOK_URL_LINKMEMO', 'DISCORD_TICKET_WEBHOOK_URL_IDEAREPOSITORY', 'SENTRY_DSN', 'RC_SANDBOX_GRANT', 'RC_SECRET_API_KEY', 'RC_SECRET_API_KEY_JOGAK'];

const targetArg = process.argv.indexOf('--target');
const target = targetArg >= 0 ? process.argv[targetArg + 1] : 'production';

const env = new Map<string, string>();
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
  if (m) env.set(m[1], m[2].trim());
}

/** `vercel env add <key> <target>` 를 띄우고 stdin 에 값만 쓴다(개행 없음). */
function addEnv(key: string, value: string): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn('npx', ['vercel', 'env', 'add', key, target, '--force'], {
      cwd: new URL('..', import.meta.url).pathname.replace(/^\//, ''),
      shell: true,
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    p.stdin.write(value); // 개행 없이 값만
    p.stdin.end();
    p.on('close', (code) => resolve(code ?? 1));
  });
}

for (const key of KEYS) {
  const value = env.get(key);
  if (!value) {
    console.log(`SKIP  ${key} (비어 있음 — 미설정 상태를 그대로 유지)`);
    continue;
  }
  const code = await addEnv(key, value);
  console.log(`${code === 0 ? 'OK   ' : 'FAIL '} ${key} → ${target} (${value.length}자)`);
}
