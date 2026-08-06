# common_server

여러 로컬 앱이 공유하는 백엔드. **현재 범위: 공지사항 + 문의하기.** 쿠폰·광고제거는 로드맵(`docs/PLAN.md` §8).

- Next.js 16 App Router (Vercel) + Supabase Postgres + Drizzle
- 설계 문서: `docs/PLAN.md` — **변경 전에 먼저 읽을 것**

## 이 서버의 성질

**1배포 N앱.** 배구 서버(`C:\project\volleyball\server`)는 `PROJ_CODE` env로 게임 하나에 고정되지만,
여기는 앱 코드가 **요청 파라미터**로 온다. 그래서 allowlist가 곧 `apps` 테이블이다(env 아님 — 앱 추가에 재배포 불필요).

**신원(subject)이 없다.** 공지는 읽기 전용 브로드캐스트, 문의는 익명 단방향이라 v1은 사용자 개념이 아예 없다.
쿠폰·광고제거를 붙일 때 `subjects` 테이블을 추가하고 `tickets.subject_id`를 **덧붙인다**(Expand-only).
기존 컬럼을 바꾸거나 지우지 않는다.

## 규약 (배구 서버에서 검증된 것들 — 재발명 금지)

- **env는 호출 시점에 읽는다.** 모듈 로드 시 캐시하면 배포 env 변경에 반응하지 못한다.
- **관리자·크론은 fail-closed.** `ADMIN_TOKEN` 16자 미만이면 관리자 기능 전면 차단. 크론은 배포 환경에서 시크릿 없으면 거부.
- **레이트리밋은 fail-open.** 그래서 무인증 라우트의 실질 방어선은 **DB 기반 일일 캡**(`apps.ticketDailyCap`)이다.
- **응답 후 처리는 `afterSafe()`로.** 서버리스 freeze로 알림이 유실되고, 무가드 `after()`는 요청 밖에서 throw한다.
- **Sentry는 `sentryEnabled()` 한 곳에서만 판단.** `instrumentation.ts`와 `lib/observability.ts`가 공유한다 — 어긋나면 절반만 막혀 로컬 에러가 운영으로 샌다.
- **미등록·비활성 앱은 404.** 400을 주면 "있는 앱인지"를 탐지당한다.
- **개인정보 최소수집.** 문의에 저장하는 기기정보는 platform·appVersion 뿐. IP는 레이트리밋 키로만 쓰고 버린다.

## 배포 (2026-08-06 기준)

| | |
|---|---|
| 프로덕션 | https://common-server.vercel.app |
| Vercel | `sonws/common-server` (CLI 배포 — GitHub 연동 없음) |
| Supabase | `common-server` / ref `nhpnvwwhuyvwcmkkhayc` / ap-northeast-2 |
| 풀러 | `aws-0-ap-northeast-2.pooler.supabase.com` — 런타임 `:6543`(transaction) · 마이그레이션 `:5432`(session) |
| Vercel env | `DATABASE_URL` · `ADMIN_TOKEN` · `CRON_SECRET` · `DISCORD_TICKET_WEBHOOK_URL_MYWORD` (production만). **Upstash·Sentry는 미설정 = 의도적 no-op** |

env를 바꾸면 **재배포해야 적용된다**(기존 배포는 빌드 시점 환경을 들고 있다). `node tools/_vercel_env.ts && npx vercel --prod --yes`.

⚠ **로컬 dev가 프로덕션 DB를 쓴다.** Supabase 무료 티어는 활성 프로젝트 2개(배구 + 공통)라 dev 전용 프로젝트를
더 만들 수 없다. 그래서 `npm run dev`로 만든 데이터는 **운영 데이터와 같은 테이블에 쌓인다**.
- 가드가 만드는 문의는 본문에 `[_dv_public]` 접두사를 박는다 — 운영 문의와 구분하기 위한 유일한 표식이다.
- 파괴적인 실험(대량 삽입·삭제)은 로컬 Postgres를 따로 띄워서 할 것. `DATABASE_URL`만 바꾸면 된다.
- Supabase Data API는 **꺼져 있다**(프로젝트 생성 시 비활성). 우리는 Postgres에 직결하므로 필요 없고,
  켜면 `tickets`(문의 본문)·`announcements`가 anon key만으로 노출된다.

## 명령

```bash
npm run dev          # localhost:3100
npm run typecheck    # 커밋 전 필수
npm run db:push      # ⚠ Session/Direct(:5432) DATABASE_URL 로 실행할 것(풀러 :6543는 DDL 부적합)

node tools/seed.ts <app_code> "<이름>"                       # 앱 최초 등록
BASE_URL=... node tools/_dv_public.ts                        # 공개 라우트 가드
BASE_URL=... ADMIN_TOKEN=... node tools/_dv_admin.ts         # 관리자 fail-closed 가드
```

`tools/*.ts`는 Node 22의 타입 스트리핑으로 `node`가 직접 실행한다(tsx 불필요).

## 구조

```
app/api/v1/{bootstrap,tickets}   공개 — 앱이 호출
app/api/admin/*                  관리자 — Bearer ADMIN_TOKEN
app/api/cron/purge               보관기간 파기(일 1회)
app/ops-4b7e21                   관리자 콘솔 (경로는 보안 장치가 아님 — 방어는 ADMIN_TOKEN)
client/                          앱에 **복사해서** 쓰는 SDK (monorepo 안 씀)
lib/                             admin·apps·notify·ratelimit·retention·observability·sentryGate·afterSafe
```

## 연동 중인 앱

| app_code | 앱 | 상태 |
|----------|-----|------|
| `myword` | `C:\project\my_word\my_word` (Expo, 로그인 없음) | 전환 예정 — 현재는 배구 서버의 `/api/ticket/anon` 사용 |

⚠ **이미 스토어에 나간 my_word 버전은 계속 배구 서버를 호출한다.** 배구의 `ANON_TICKET_PROJECTS`에서
`myword`를 빼면 구버전 문의가 죽는다. 구버전 수명이 다할 때까지 유지할 것.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
