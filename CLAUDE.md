# common_server

여러 로컬 앱이 공유하는 백엔드. **현재 범위: 공지사항 + 문의하기.** 쿠폰·광고제거는 로드맵(`docs/PLAN.md` §8).

- Next.js 16 App Router (Vercel) + Supabase Postgres + Drizzle
- 설계 문서: `docs/PLAN.md` — **변경 전에 먼저 읽을 것**
- 새 앱 붙이기: `docs/ONBOARDING.md` — 순서 · 단계별 확인 명령 · 증상→원인 표

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
  같은 이유로 **RC pull 쿨다운은 Redis가 아니라 Postgres**(`subjects.rc_pulled_at`)에 있다 — fail-open 쿨다운은 인프라가 흔들릴 때 정확히 외부 호출이 터진다.
- **응답 후 처리는 `afterSafe()`로.** 서버리스 freeze로 알림이 유실되고, 무가드 `after()`는 요청 밖에서 throw한다.
- **Sentry는 `sentryEnabled()` 한 곳에서만 판단.** `instrumentation.ts`와 `lib/observability.ts`가 공유한다 — 어긋나면 절반만 막혀 로컬 에러가 운영으로 샌다.
- **엔타이틀먼트의 입력은 둘이다.** RC 웹훅(push) + `GET /subscribers`(pull, `lib/rcPull.ts`). 웹훅은 5회 재시도 후 포기하므로 push만으로는 유실이 영구 손실이 된다.
- **미등록·비활성 앱은 404.** 400을 주면 "있는 앱인지"를 탐지당한다.
- **문의 미처리 = 대기(open) + 확인 중(reviewing).** 뱃지·대시보드·기본 필터가 같은 정의를 쓴다.
  상태는 운영자가 정하는 값이지 **입력의 부수효과가 아니다** — 메모를 썼다고 자동으로 답변완료가 되면
  "적어두기만 하고 아직 답은 안 함"을 표현할 수 없다. `replied`/`resolved`는 앱(`tickets/mine`)에 나가는
  값이라 **개명하지 않는다**(추가는 하되 개명은 안 한다).
- **관리자 write는 앱 스코프가 필수다.** 1배포 N앱이라 id만으로 UPDATE하면 콘솔이 A앱을 보는 중에
  B앱 레코드가 조용히 바뀐다. 읽기에 `appCode`를 걸었으면 **쓰기에도** 건다.
- **조용한 no-op은 화면에 드러낸다.** 디스코드 웹훅·RC 키·Upstash·Sentry는 없어도 서버가 잘 돈다 —
  그래서 안 붙은 줄 모른다. `/api/admin/stats`의 `infra`가 **붙었는지 여부만**(값 아님) 콘솔에 알린다.
- **개인정보 최소수집.** 문의에 저장하는 기기정보는 platform·appVersion 뿐. IP는 레이트리밋 키로만 쓰고 버린다.
- **활성은 `lastSeenAt`이 아니라 `subject_active_day`에서 온다.** lastSeenAt은 주체당 한 칸이라 덮어쓰여져
  과거 DAU를 복원하지 못한다 — 날짜 축은 최신 쪽으로 단조 편향되어 왜곡이 조용하다.
  하트비트는 `bootstrap`(토큰 있을 때) · `devices` · `auth/login` 세 곳이고, `(app, subject, day)` PK가 멱등을 보장한다.
  ⚠ **`bootstrap`에서만 토큰이 선택**이다 — 무효해도 401이 아니라 조용히 무시한다.
  세션 만료가 진입 게이트(점검·강제업데이트) 판정을 막으면 안 되기 때문이다.
- **"수집 전 0"과 "진짜 0"을 구분해서 그린다.** 표본 없는 요일은 `avg: null`이지 0이 아니고,
  차트 게이트의 판정 축은 표본 수가 아니라 **수집 경과일**이다(`samples`는 활성자 0명이어도 창 길이만큼 차서 항상 참이다).

## 배포 (2026-08-06 기준)

| | |
|---|---|
| 프로덕션 | https://common-server.vercel.app |
| Vercel | `sonws/common-server` (CLI 배포 — GitHub 연동 없음) |
| Supabase | `common-server` / ref `nhpnvwwhuyvwcmkkhayc` / ap-northeast-2 |
| 풀러 | `aws-0-ap-northeast-2.pooler.supabase.com` — 런타임 `:6543`(transaction) · 마이그레이션 `:5432`(session) |
| Vercel env | `DATABASE_URL` · `ADMIN_TOKEN` · `CRON_SECRET` · `DISCORD_TICKET_WEBHOOK_URL_MYWORD` (production만). **Upstash·Sentry·`RC_SECRET_API_KEY_*`는 미설정 = 의도적 no-op** |

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
BASE_URL=... node tools/_dv_auth.ts                          # 로그인·세션 가드
BASE_URL=... node tools/_dv_sdk.ts                           # client/ 가 서버 계약과 맞는지
node tools/_dv_purchase.ts                                   # 결제 판정·상태전이(DB 불필요). BASE_URL 주면 라우트도
node tools/_dv_activity.ts                                   # 활성 집계 순수함수(DB 불필요)
```

`tools/*.ts`는 Node 22의 타입 스트리핑으로 `node`가 직접 실행한다(tsx 불필요).

## 구조

```
app/api/v1/{bootstrap,tickets,auth,entitlements}  공개 — 앱이 호출
app/api/webhooks/revenuecat/[app]  RevenueCat 수신 (v1 밖 — 서버간, CORS 대상 아님)
app/api/admin/*                  관리자 — Bearer ADMIN_TOKEN
  └ stats                        대시보드 지표 · 운영 알림(임계 판정은 서버) · 웹훅 오류 집계 · 배선 상태
  └ subjects                     사용자 목록(문의 수·구독 상태). provider_id 원문은 안 내려준다
                                 stats의 `activity`가 DAU/WAU/MAU·일별 추이·요일 평균을 들고 온다
app/api/cron/purge               보관기간 파기(일 1회)
app/ops-4b7e21                   관리자 콘솔 (경로는 보안 장치가 아님 — 방어는 ADMIN_TOKEN)
client/                          앱에 **복사해서** 쓰는 SDK (monorepo 안 씀)
lib/                             admin·apps·auth·revenuecat·rcPull·entitlement·notify·ratelimit·retention·observability·afterSafe
  └ activity / activityMath      활성 기록·집계. 순수 계산을 나눈 이유는 가드가 DB 없이 호출해야 해서다
```

## 연동 중인 앱

앱의 SDK 복사본 버전은 **운영 지표에 직결**된다 — 2026-09-01 미만은 부팅 시 세션을 안 실어 보내므로
그 앱의 DAU는 **재배포 전까지 0**이다(콘솔이 "활성 계측 미수집"으로 표시한다).

| app_code | 앱 | SDK 복사본 | 상태 |
|----------|-----|-----------|------|
| `myword` | `C:\project\my_word\my_word` (Expo, 로그인 없음) | **2026-08-06** | 문의는 이미 공통 서버로 들어온다. 하지만 최초판 SDK라 **신원(deviceId)이 없다** — 문의가 전부 익명이라 답변을 돌려줄 경로가 없고 DAU도 안 잡힌다 |
| `jogak` | 일기 앱 (Expo, Android `com.son0925.jogak`, 구글 로그인) | 2026-08-19 | 2026-08-09 등록. 문의는 **로그인 필수** 구조 |
| `linkmemo` | `C:\project\link_memo` (Expo, 로그인 없음) | 2026-08-14 | `ensureDeviceSession()` 보유 — 하트비트를 붙이는 기준 구현체 |
| `idearepository` | `C:\project\idea_repository` (Expo, 로그인 없음) | 2026-08-14 | 2026-08-17 등록. linkmemo와 같은 구조 |

⚠ **이미 스토어에 나간 my_word 버전은 계속 배구 서버를 호출한다.** 배구의 `ANON_TICKET_PROJECTS`에서
`myword`를 빼면 구버전 문의가 죽는다. 구버전 수명이 다할 때까지 유지할 것.

⚠ **jogak 문의는 디스코드 알림이 안 간다.**(콘솔 대시보드의 "배선 상태"가 이걸 표시한다) `DISCORD_TICKET_WEBHOOK_URL_JOGAK`(또는 앱 공통
`DISCORD_TICKET_WEBHOOK_URL`)이 없어서 `notify`가 no-op이다. 콘솔을 직접 열어보기 전까지
문의가 들어온 줄 모른다 — 웹훅을 넣고 재배포해야 알림이 붙는다.

앱 코드는 `apps` 테이블이 allowlist라 재배포 없이 늘어나지만, **env로 남은 둘은 재배포가 필요하다** —
디스코드 알림 채널(`DISCORD_TICKET_WEBHOOK_URL_*`)과 RC pull 키(`RC_SECRET_API_KEY_*`). 둘 다 없으면 조용히 no-op이라 **안 붙은 줄 모른다.**

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
