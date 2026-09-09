# common_server

여러 로컬 앱이 공유하는 백엔드. **현재 범위: 공지사항 + 문의하기.** 쿠폰·광고제거는 로드맵(`docs/PLAN.md` §8).
**2026-09-07 추가: 정보 허브**(지원사업·커뮤니티 수집) — 앱 기능이 **아니다**. 운영자 전용이고 `docs/INFO_HUB.md`가 정본.

- Next.js 16 App Router (Vercel) + Supabase Postgres + Drizzle
- 설계 문서: `docs/PLAN.md` — **변경 전에 먼저 읽을 것**
- 새 앱 붙이기: `docs/ONBOARDING.md` — 순서 · 단계별 확인 명령 · 증상→원인 표
- **정보 훑기 스킬: `.claude/skills/info-scan/`** — 바깥 정보를 **저장하지 않고** 그 자리에서 가져와 골라 준다.
  🔴 저장 방식(RSS 17개)을 켰다가 **721건 쌓이고 0건 읽혀 껐다**(`INFO_HUB.md` §11-C) — 그 대체다.
  성패는 "많이 가져오기"가 아니라 **"적게 남기기"**에 있다. 원자료 60건을 그대로 옮기면 그 실패의 반복이다.
- **정보 허브: `docs/INFO_HUB.md`** — 지원사업·커뮤니티 수집. 🔴 **`appCode` 규약의 명시적 예외**(§1-1)이고,
  `/api/v1/*`를 **안 만든다**(§1-2). 스레드 검증 규약(§10-B)은 *"확인 안 됨"과 "거짓"을 구분*하는 것이 전부다.
- **다음 작업: `docs/NEXT.md`** — 미결 목록. 끝나면 지우거나 PLAN으로 옮긴다(남겨두면 썩는다).
- **앱 세션에 알리기: `docs/MULTI_SESSION.md`** — 앱마다 세션이 따로 돌고 이 저장소가 허브다.
  `SDK_VERSION`을 올렸으면 **네 세션에 알리는 것까지가 일**이다 — 안 보내면 앱은 모른 채로 구버전을 안고 배포한다.

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
  `lastSeenAt`은 **매 부팅 갱신한다**(2026-09-01 정정 — 처음엔 하루 1회로 묶었는데 그러면 그날 첫 접속 시각에
  고정돼 "지금 몇 명 있나"(최근 30분)를 잴 수 없었다). 둘은 역할이 다르다: 활성 일자는 **덮어써지지 않는 과거**,
  `lastSeenAt`은 **지금 이 순간**.
  ⚠ **`bootstrap`에서만 토큰이 선택**이다 — 무효해도 401이 아니라 조용히 무시한다.
  세션 만료가 진입 게이트(점검·강제업데이트) 판정을 막으면 안 되기 때문이다.
- **시간대 분포는 `lastSeenAt`으로 그리지 않는다.** 그건 주체당 한 칸이라 "몇 시에 마지막으로 껐나"가 된다.
  `subject_active_day.hours`가 KST 0~23시를 비트 24개로 들고 있고(OR이라 멱등), 집계는 `generate_series`로 펼친다.
  ⚠ **시각 수집일은 날짜 수집일과 다른 축**이다 — 시각은 2026-09-01부터라 이전 행은 `hours=0`으로 히스토그램에 안 든다.
- **세션 토큰은 부팅 때 슬라이딩 갱신한다.** 발급 경로가 로그인·기기등록 둘뿐이라 종전엔 `iat + 180일`이
  **고정 카운트다운**이었다 — 앱을 매일 써도 그날이 오면 토큰이 죽었다. 그런데 bootstrap은 무효 토큰을
  401 없이 조용히 무시하므로(위 규약), 그 사용자는 **DAU에서 영구히 사라지고 앱도 서버도 모른다**.
  이제 발급 30일이 지난 토큰은 bootstrap이 새로 발급해 응답에 싣고(`session.token`) SDK가 조용히 교체한다.
  갱신 시에만 주체 생존을 DB로 한 번 확인한다 — 탈퇴한 세션을 연장해주지 않기 위해서다.
  ⚠ SDK의 `isSignedIn()`도 **만료를 본다**. "저장소에 문자열이 있나"로 두면 죽은 토큰을 들고
  `ensureDeviceSession()`이 재등록을 영원히 건너뛴다 — 같은 공백이 앱 쪽에서 재현된다.
- **"수집 전 0"과 "진짜 0"을 구분해서 그린다.** 표본 없는 요일은 `avg: null`이지 0이 아니고,
  차트 게이트의 판정 축은 표본 수가 아니라 **수집 경과일**이다(`samples`는 활성자 0명이어도 창 길이만큼 차서 항상 참이다).
- **지표에는 출처와 정의를 붙인다.** 숫자만 놓으면 "이게 우리 값인가 RC 값인가", "오늘이 UTC인가 KST인가"를
  매번 코드로 되추적하게 된다. 대시보드의 메타 줄과 `Src` 배지가 그걸 화면에 박아둔다.
- **알림이 0건일 때 무엇을 봤는지를 말한다.** 빈 화면은 "정상"과 "판정 자체를 안 함"을 구분해주지 못한다.
  `stats`가 `alertChecks`로 검사 항목을 함께 내려보낸다 — **판정문을 늘리면 그 목록도 같이 늘린다**.
- **미설정은 고치는 방법까지 화면에 적는다.** 배선 상태가 env **이름**을 같이 보여준다(`infraEnv`).
  이름 규칙은 `lib/notify.ts`·`lib/rcPull.ts`가 가지고 있고 서버가 조립해 내려보낸다 — 화면에 베껴 쓰면 어긋난다. 값은 절대 안 나간다.

## 배포 (2026-08-06 기준)

| | |
|---|---|
| 프로덕션 | https://common-server.vercel.app |
| Vercel | `sonws/common-server` (CLI 배포 — GitHub 연동 없음) |
| Supabase | `common-server` / ref `nhpnvwwhuyvwcmkkhayc` / ap-northeast-2 |
| 풀러 | `aws-0-ap-northeast-2.pooler.supabase.com` — 런타임 `:6543`(transaction) · 마이그레이션 `:5432`(session) |
| Vercel env | `DATABASE_URL` · `ADMIN_TOKEN` · `CRON_SECRET` · `DISCORD_TICKET_WEBHOOK_URL_MYWORD` (production만). 정보 허브가 붙으면 `DATA_GO_KR_SERVICE_KEY` · `THREADS_ACCESS_TOKEN` · `DISCORD_INFO_WEBHOOK_URL` 추가(`docs/INFO_HUB.md` §8). **Upstash·Sentry·`RC_SECRET_API_KEY_*`는 미설정 = 의도적 no-op** |

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
node tools/_dv_contrast.ts                                   # 색 대비 — globals.css를 읽어 계산(DB 불필요)
node tools/_dv_info.ts                                       # 정보 허브 순수계산. BASE_URL+ADMIN_TOKEN 주면 라우트·경로간 대조까지
node --env-file=.env.local tools/seed_info.ts                # 정보 허브 수집원 등록(멱등 · enabled=false로 만든다)
node --env-file=.env.local .claude/skills/info-scan/fetch.mjs --category ai --days 5   # 저장 없이 그 자리에서 훑기

BASE_URL=... node tools/_e2e_heartbeat.ts                    # ⚠ 하트비트 성공 경로 — 행을 만들고 끝에 지운다
```

🔴 **가드는 `ALL PASS`만 보지 말고 실행 개수를 본다.** 각 가드가 `MIN_CHECKS` 바닥을 들고 있고
요약 줄이 `(실행 N / 최소 M)`을 함께 찍는다 — 섹션이 조건부로 스킵되면 개수만 줄고 마지막 줄은
여전히 초록이기 때문이다. **검사를 늘렸으면 그 숫자도 같이 올린다**(귀찮은 게 요점이다 —
안 올리면 다음에 섹션이 죽어도 안 걸린다).
> 계기: my_word가 jest 스위트 9개 중 7개가 로드조차 안 되는 걸 뒤늦게 찾았다. **죽은 스위트의 테스트는
> 실패가 아니라 세어지지도 않아** `26 passed, 26 total`로 보였고, 140개에서 줄어든 걸 아무도 대조하지
> 않아 **그 상태로 프로덕션에 나갔다**(2026-09-02). 우리 `_dv_admin`도 `ADMIN_TOKEN` 없이 돌리면
> 19개만 돌고 조용히 `ALL PASS`였다 — 지금은 바닥에 걸린다.

🔴 **개수 축으로는 안 잡히는 고장이 하나 있다 — "돌면서 아무것도 안 보는 검사".**
`MIN_CHECKS`·`KNOWN_SKIPS`는 **"몇 개가 돌았나"**를 본다. 통과가 보장된 검사(`check(name, true)`)는
그 축을 **통과하면서** 바닥까지 채운다 — 개수는 실행량이지 검증량이 아니다.
→ **변이 테스트 말고는 자동으로 잡을 방법이 없다.** 가드를 새로 만들거나 고쳤으면 **일부러 깨보고
FAIL이 나는지** 확인한다. 오늘 셋을 그렇게 찾았다(`catch` 미경유 · 대조군 소실 · 허위 오라클).
⚠ **허위 오라클 스캐너를 상시 가드로 두지 않는다.** 실측 1건짜리에 스캐너를 상시로 두면
오탐 관리 비용이 더 크다 — **사건이 있을 때 훑고 결과만 남긴다**(2026-09-02 훑음: `check(…, true)` 0건,
약한 오라클 0건, `typeof` 검사 3건은 전부 서버 계약을 실제로 보는 진짜 단언).

🔴 **초록이 거짓인 방식은 세 층이다**(2026-09-08 SnoreLess 정리 — 하루에 셋 다 실측됐다).

```
0층  검사가 실행은 되는가          ← 에러가 stderr 로 가고 삼켜진다. 종료코드도 "매치 없음"과 같아진다
1층  검사가 발화하는가              ← 정규식·문자 클래스에 틈이 있다
2층  발화 케이스가 현실을 덮는가    ← 깨뜨려 FAIL 은 봤는데, 깨뜨린 방식이 실제 결함과 다르다
```

**0층 실측** — SnoreLess 가 두 번 보고한 *"제어문자 0건"* 은 측정이 아니라 **침묵**이었다:

```bash
LC_ALL=C grep -qP '[\x00-\x08…]' file   # 🔴 grep: -P supports only unibyte and UTF-8 locales
                                        #    종료코드 2, 매 파일에서 죽고 있었다
… 2>/dev/null                           # 에러가 삼켜지고, -q 라 종료코드도 "매치 없음"과 구분이 안 된다
```

**`LC_ALL=C` 와 `grep -P` 는 같이 못 쓴다**(직접 재현 확인). 112개 파일 전부가 조용히 통과했다.
⚠ 내 python 전수에도 같은 모양이 있었다 — `except Exception: continue` 는 **못 읽은 파일을 조용히 건너뛴다.**
세어 보니 950개 중 946개를 실제로 읽었고 스킵 0건이었지만, **구멍은 있었고 안 밟혔을 뿐**이다.
→ **검사는 "몇 개를 실제로 읽었는지"를 찍는다.** `MIN_CHECKS` 규약과 같은 이유다.

🔴 **0층·1층·2층 전부 양성 대조 하나로 걸린다** — 고의로 깨뜨렸는데 FAIL 이 안 나면
발화를 의심하기 전에 **실행을 의심하게 된다.** 그게 이 절이 양성 대조를 일반해로 부르는 이유다.

🔴 **검사가 살아 있는지는 고의로 깨뜨려 확인한다 — 이게 이 결함군의 유일한 일반해다**(2026-09-08 SnoreLess).
초록은 *"문제가 없다"* 가 아니라 *"이 검사가 아무것도 안 봤다"* 일 수도 있다.
**양성 대조**(없는 키·깨진 값을 임시로 심고 FAIL 이 나는지 본 뒤 지우기)는 **원인을 안 가린다** —
제어문자든, 정규식 오타든, 스캔 대상 목록이 비었든 **한 번에 걸린다.**
⚠ 아래 grep 은 **원인 하나만** 잡는다. 정규식은 멀쩡한데 **디렉토리명이 바뀌어 스캔 목록이 빈**
경우는 제어문자가 없어 그 훑기를 통과한다. 양성 대조는 잡는다.

🔴 **그 "아무것도 안 보는 검사"가 생기는 기계적 경로를 하나 찾았다 — 이스케이프 계층이 정규식을 먹는다**(2026-09-08).
파이썬 heredoc·sed·셸 원라이너를 거쳐 파일을 쓰면 `\b`·`\v`·`\r`·`\1` 이
**제어문자 0x08·0x0b·0x0d·0x01 로 바뀌어 박힌다.** 화면에는 안 보이고,
정규식은 **에러 없이 아무것도 안 매칭하며 통과한다.**

```
실측 — idea_repository/scripts/check-i18n.mjs:74 (2026-08-20 커밋 ca47065 부터)
  의도:  /\bt\(\s*'([^']+)'/g      → t('key') 호출을 모으는 것
  실제:  /<0x08>t\(\s*'([^']+)'/g  → **항상 0건**
  결과:  "리소스에 없는 키" 검사가 **19일간 FAIL 이 원리적으로 불가능**한 상태로 초록이었다.
```

🔴 **정규식만의 문제가 아니다.** 다음 사람이 **복붙할 문자열** — 경로·명령·env 값 — 도 같은 방식으로 조용히 틀린다.
2026-09-08 하루에 실측된 것이 **셋 다 경로**였다:

```
D:\emulators\basketball_story  →  D:\emulators<0x08>asketball_story   (\b)
D:\emulators\reread            →  D:\emulators<0x0d>eread             (\r)
C:\project\volleyball          →  C:\project<0x0b>olleyball           (\v)
```

⚠ `\r` 만 우연히 눈에 띄었다 — CR 이 커서를 되돌려 출력이 이상해 보였기 때문이지 **검사가 잡은 게 아니다.**
`\b`·`\v` 는 화면상 아무 표시가 없다. 공통점은 **"보이지 않게 틀린다"** — `\b` 는 검사를 죽이고 경로는 사람을 속인다.

### 이 축은 **grep 으로 못 닫는다 — 바이트 판독기가 있어야 한다**

Git Bash 의 GNU grep 은 **CRLF 파일 안의 CR 을 아예 안 보여준다** — 줄 중간에 박힌 것까지 같이 사라진다.
`core.autocrlf=true` 면 체크아웃만으로 `.md` 가 전부 CRLF 라, **가장 흔한 경우가 정확히 안 보이는 경우**다.

```
CRLF 문서 + 줄 중간 CR (실제 CR 3개)
  grep -cP '\x0d'   → 0    🔴 못 본다
  바이트 판독기      → 1    🟢
```

→ `|\x0d(?!$)` 같은 grep 패턴은 **죽은 코드이고, 더 나쁘게는 "CR 도 보고 있다"는 거짓 안심**을 준다.
⚠ **내가 그걸 두 번 전파했다** — 처음엔 CR 을 아예 빼먹었고, 고쳤다고 보낸 `\x0d(?!$)` 도 이 환경에선 발화하지 않는다.

**쓸 것** — 규칙은 한 줄이다: **CR 은 바로 뒤가 LF 일 때만 정상**(= CRLF 의 CR). 그 외는 결함.

```js
for (let i = 0; i < buf.length; i++) {
  const b = buf[i];
  if (b >= 32 || b === 9 || b === 10) continue;
  if (b === 13 && buf[i + 1] === 10) continue;   // CRLF 의 CR 만 통과
  결함으로 기록
}
```

🔴 **CR 을 통짜로 금지하면 안 된다** — autocrlf 환경에선 가드가 온통 오탐이 되어 **꺼진다.**
**꺼진 가드는 죽은 가드보다 나쁘다**(다음 사람이 "원래 시끄러운 것"으로 배운다).
→ 축은 **"CR 을 허용하나"가 아니라 "CR 이 어디에 있나"** 다. 같은 바이트인데 **위치가 의미를 가른다.**

### 🔴 규칙이 아니라 **케이스 목록**을 전파한다

이 결함은 **세 세션이 연달아 같은 모양으로** 밟았다:

```
농구명가  9~13 통짜 허용     → VT(11)·FF(12) 를 놓침
Re:Read   첫 판이 **자기가 당한** CR 을 못 잡음
나         TAB·LF·CR 허용     → 줄 중간 CR 을 놓침  (앞의 둘을 고쳐 준 쪽이 낸 세번째)
```

🔴 **세번째가 제일 무서운 점은** 그게 *"이 결함을 방금 이해한 사람"* 이 낸 것이라는 데 있다.
문자 집합은 **눈으로 봐서 틈이 안 보인다** — 셋 다 읽으면 맞는 규칙처럼 보인다.
빠진 것은 생각이 아니라 **실행**이었다. 받는 쪽이 자기 구현에 넣고 돌리면 어떤 형태로 짰든 틈이 드러난다.

**자가 검증 샘플은 이 여덟이 다 들어가야 한다**(바로 이 순서로 구멍이 드러났다):

```
정상 CRLF · 깨끗한 LF · CRLF+줄중간CR · LF+줄중간CR · lone-CR · 0x08 · 0x0b · 0x0c
```

⚠ **반대 명제도 같이 잰다** — 농구명가 실측으로 그 트리에 **CRLF 파일이 89개**였다.
CR 을 통짜로 막았으면 **오탐 89건**이고, 그러면 다음 사람이 가드를 끈다.
🔴 **가드를 끄게 만드는 가드가 가장 나쁘다.** 한쪽만 재면 반대쪽이 무너진다.

⚠ **범위를 소스 디렉터리로 좁힌다.** `| grep -v node_modules` 는 **다 스캔한 뒤 출력만 거르는 것**이라
느린 건 그대로다(My Word 실측: 120초 초과) — `--exclude-dir` 로 스캔에서 제외한다.

🔴 **쓸 때는**: **역슬래시가 든 문자열을 heredoc·JSON 으로 파일에 쓰지 않는다**(SnoreLess 제안).
**계층이 하나 늘 때마다 역슬래시가 하나씩 먹힌다.** 편집 도구나 **파일로 저장한** 스크립트를 쓴다
(`python -c`·`node -e`·`printf` 같은 셸 원라이너도 계층이다 — idea_repository 가 2회 연속 거기서 재오염됐다).
굳이 인라인이면 `chr(92)` 로 조립한다.

🔴 **이 결함의 자연 발생률은 낮지 않다 — 가장 조심하던 순간에도 난다.**
SnoreLess 가 가드를 만들고 **3분 뒤 첫 실행**에서 진짜 결함 4건을 물었는데, 그걸 심은 것은
*"이스케이프 계층에서 이 두 글자가 접혀 정규식을 조용히 죽인다"* 라는 **그 문장을 쓰던 자신**이었다.
문장 안의 `\b`·`\v` 가 **정확히 그 메커니즘으로 접혔다.**
★ 변이 테스트보다 강한 증거다 — **변이는 내가 만든 결함이고 이건 진짜였다.**
⚠ **고칠 때는 `Edit` 이 안 먹는다** — `Read` 가 제어문자를 **지워서 보여주므로** 앵커 문자열이 실제 바이트와
어긋난다(2026-09-08 던전가이드 실측). **코드포인트로 다뤄야 한다**(`chr(8)` 로 찾아 치환).
🔴 그래서 이 결함은 **보이지도 않고, 보이게 만든 뒤에도 평소 방식으로는 못 고친다.**
🔴 **그리고 파이썬 `open(...,'w')` 는 인코딩 예외가 나기 전에 파일을 먼저 비운다 — 이 축은 *내용*이 아니라 *파일*을 파괴한다.**
같은 날 **두 번** 났다: 이 파일(surrogate 이스케이프 하나 때문에 **0바이트**, `git checkout` 으로 복구 —
그날 커밋 안 된 편집은 잃었다) · `common/ACCOUNT_LIFECYCLE.md`(**20,408 → 0바이트**, Re:Read 세션. `common` 은
git 밖이라 **사본이 유일한 복구 수단**이었다).

⚠ **"에러 났으니 원본은 그대로겠지"가 틀렸다.** 쓰기는 이미 시작돼 있다 — 에러 메시지만 보면 안전해 보인다.

```python
# 🚫 부분 파괴가 난다 — 청크로 인코딩하며 쓰기 때문
io.open(p, 'w', encoding='utf-8').write(s)

# ✅ 인코딩을 파일 열기 **전에** 끝낸다 — 실패하면 여기서 멈추고 원본은 무사하다
data = s.encode('utf-8')
tmp = p + '.tmp'; open(tmp, 'wb').write(data); os.replace(tmp, p)
```

⚠ **파이썬에서 이모지는 `\U0001F534` 로 쓴다.** `🔴` 같은 서로게이트 쌍은 **인코딩 자체가 안 된다** —
이 파일을 날린 것이 정확히 그거였다.
🔴 **커밋 안 된 파일·git 밖 파일을 스크립트로 덮어쓰지 않는다.** 고칠 거면 **먼저 사본을 뜬다.**

⚠ **변이 테스트를 되돌릴 때**: 백업은 **그 자리에서 새로 뜬다**(재사용 금지). 복원 뒤 잔여물을 확인한다.
`git checkout`은 **같은 커밋의 다른 변경까지** 되돌리고, 낡은 백업은 **그 사이 커밋을** 되돌린다 —
2026-09-02에 나와 my-word 세션이 각각 한 번씩, 거울상으로 밟았다.

⚠ `_dv_purchase.ts`의 "RC 키 없으면 no-op" 항목은 **env에 `RC_SECRET_API_KEY_*`가 있으면 실패한다**(전제가 성립하지 않으므로).
`.env.local`을 source한 셸에서 돌릴 땐 `env -u RC_SECRET_API_KEY_JOGAK`로 뺀다.

⚠ `_e2e_heartbeat.ts`만 **가드가 아니다** — 상시 실행용이 아니라 성공 경로 1회 확인용이고,
`subjects`·`subject_active_day`에 **실제 행을 만든다**(끝에서 지운다). 로컬 dev가 프로덕션 DB를 쓰므로
상시 가드에 넣으면 돌릴 때마다 `사용자` 수와 DAU가 조용히 부푼다.

`tools/*.ts`는 Node 22의 타입 스트리핑으로 `node`가 직접 실행한다(tsx 불필요).

## 구조

```
app/api/v1/{bootstrap,tickets,auth,entitlements}  공개 — 앱이 호출
app/api/webhooks/revenuecat/[app]  RevenueCat 수신 (v1 밖 — 서버간, CORS 대상 아님)
app/api/admin/*                  관리자 — Bearer ADMIN_TOKEN
  └ stats                        대시보드 지표 · 운영 알림(임계 판정은 서버) · 웹훅 오류 집계 · 배선 상태
  └ subjects                     사용자 목록(문의 수·구독 상태). provider_id 원문은 안 내려준다
                                 stats의 `activity`가 DAU/WAU/MAU·일별 추이·요일 평균을 들고 온다
app/api/cron/purge               보관기간 파기(일 1회) — 정보 허브 항목 파기도 여기 얹혀 있다
app/api/cron/info                정보 허브 수집(일 1회 · KST 06:00) — `docs/INFO_HUB.md`
app/api/admin/info               정보 허브 목록·소스 — ⚠ **앱 스코프 없음**(유일한 예외). 서버가 `appScoped:false`로 선언
lib/info.ts                      수집 어댑터·URL 정규화·기간 파싱. 순수 계산이라 가드가 DB 없이 호출한다
app/ops-4b7e21                   관리자 콘솔 (경로는 보안 장치가 아님 — 방어는 ADMIN_TOKEN)
client/                          앱에 **복사해서** 쓰는 SDK (monorepo 안 씀)
lib/                             admin·apps·auth·revenuecat·rcPull·entitlement·notify·ratelimit·retention·observability·afterSafe
  └ activity / activityMath      활성 기록·집계. 순수 계산을 나눈 이유는 가드가 DB 없이 호출해야 해서다
```

## 연동 중인 앱

앱의 SDK 복사본 버전은 **운영 지표에 직결**된다 — 2026-09-02 미만은 **포그라운드 복귀를 안 센다**.
그 앱의 DAU는 "앱을 새로 켠 사람"만 잡히고, 콘솔이 **"웜 스타트 계측 미부착"** 으로 표시한다.
🔴 **코드가 있는 것과 사용자에게 닿은 것은 다르다** — 서버는 **실제 신호로만** 판정한다.
스토어·OTA 현황은 `C:\project\common\PLAY_CONSOLE_STATUS.md`(§2-1 스토어 · §2-4 OTA · §5 도달).

| app_code | 앱 | SDK 복사본 | 상태 |
|----------|-----|-----------|------|
| `myword` | `C:\project\my_word\my_word` (Expo, 로그인 없음) | **2026-09-02** | 🟢 프로덕션(19/1.3.3 · 145개국 · 2026-09-07 실측). 웜 스타트 하트비트 부착(OTA). ~~최초판 SDK라 신원이 없다~~ → 기기 subject 도입 완료 |
| `jogak` | 일기 앱 (Expo, Android `com.son0925.jogak`, 구글 로그인) | **2026-09-02** | 🟢 **프로덕션**(19/0.2.6 · 게시 **2026-09-04 23:43** · 1개국 · 2026-09-07 콘솔 실측). 웜 신호 **✅ 2026-09-04 도착** — 9/3의 `warmSince: null` 은 미부착이 아니라 **아무도 안 켠 날**이었다(아래 ①/② 규칙이 ②로 판정된 첫 실례). 2026-08-09 등록. 문의는 **로그인 필수** 구조. ⚠ 주체가 2행이다(아래 정의 참조) — 콘솔이 `subjectsDualCounted`로 **스스로 판정해 경고를 띄운다**(앱 코드 하드코딩 아님) |
| `linkmemo` | `C:\project\link_memo` (Expo, 로그인 없음) | **2026-09-02** | 🟢 프로덕션(11/1.0.7 · 177개국 · 2026-09-07 실측). 웜 스타트 하트비트 부착(OTA). `ensureDeviceSession()` 기준 구현체 |
| `idearepository` | `C:\project\idea_repository` (Expo, 로그인 없음) | **2026-09-02** | 🟢 **프로덕션**(2026-09-02 15:29 · 11/1.0.10 · 177개국). 웜 스타트 하트비트 부착. 알파 트랙 병행 유지.<br>🔴 ~~자연 도달 확정 1호~~ **취소**(2026-09-07 DB 실측) — 9/2~9/4 DAU 의 주력은 **15초 등간격으로 생성·재방문한 스크립트 15개**였다. 활성일·시각 비트가 15개 모두 동일. 상세와 재보정은 `docs/NEXT.md §3` |

🔴 **`warm_uncollected` 경고를 "미부착"으로 읽지 마라 — 서버는 그걸 구분하지 못한다.**
그 판정의 입력은 **웜 신호 유무 하나뿐**이라, 아래 둘이 같은 화면으로 나온다:

```
① 코드가 안 붙었다        → 진짜 미부착
② 그날 아무도 앱을 안 켰다 → 웜 이벤트가 원리적으로 0
```

→ **DAU를 같이 본다.** 그 앱 DAU가 0인 날의 웜 0은 **아무것도 말해주지 않는다**(조각이 2026-09-03에
정확히 이 상태였다 — 코드는 vc17에 들어 있었다). 판정은 **그 앱이 실제로 열린 날**을 하루는 보고 한다.
✅ **그 규칙이 실제로 판정됐다(2026-09-07)** — 조각은 ②였다. 9/4에 테스터가 들어오자 같은 날 웜 신호가 왔다.

🔴 **DAU를 "사람 수"로 읽지 마라 — 자동화가 만든 행과 사람이 만든 행은 같은 모양이다.**
2026-09-02~04 idearepository의 DAU 24·16·16 중 15는 **15초 등간격으로 생성·재방문한 스크립트**였다
(활성일·시각 비트가 15개 모두 동일). "자연 도달 확정 1호"라고 문서 두 곳에 적었다가 취소했다.
```
DAU가 크다고 안전한 게 아니다 — 자동화라면 큰 쪽이 훨씬 쉽다.
먼저 볼 것은 크기가 아니라 **규칙성**이다: 생성 간격 · 활성일 · 시각 비트가 서로 같은가.
"E2E 돌린 날을 뺀다"로는 못 막는다 — 그 15개는 다음날·다다음날에도 찍었다.
축은 날짜가 아니라 **주체**다.
```

⚠ **이미 스토어에 나간 my_word 버전은 계속 배구 서버를 호출한다.** 배구의 `ANON_TICKET_PROJECTS`에서
`myword`를 빼면 구버전 문의가 죽는다. 구버전 수명이 다할 때까지 유지할 것.

**조각 DAU 정의** (2026-09-02, diary 세션 실측 — `signedIn ? commonServer : deviceServer`):

```
그날 활성으로 찍힌 subject 수
  · 비로그인      → device subject 1행
  · 로그인        → user subject 1행  (그날 device 는 안 찍는다)
  · 로그인 전환일 → 2행 (사용자당 평생 1회)
  · 연령 미달     → 0행 (식별자를 아예 발급하지 않는다)
```

🔴 그래서 **누적 `사용자` 수만 부풀어 있고 DAU는 거의 정확하다.** 둘을 같이 취급하면 안 된다.

⚠ **조각에는 "기기 세션으로 통일"을 권하지 마라**(2026-09-02에 내가 그렇게 권했다가 정정받았다). 이유가 둘이다:
- 하트비트를 기기로 고정하면 로그인 사용자는 콜드 스타트(user) + 웜 스타트(device)로 **매일 2행**이 된다.
  "평생 1회"였던 중복이 매일이 되고, 하필 **가장 열심히 쓰는 사용자**에게 그렇게 된다.
- 부팅까지 전부 기기로 통일하면 DAU는 제일 깨끗해지지만 **구글 토큰이 갱신을 못 받는다** —
  슬라이딩 갱신 지점이 `bootstrap`·`heartbeat` 둘뿐이라, 문의·구독을 180일 안 여는 사용자의 로그인이 조용히 죽는다.
  ⚠ 이건 조각만의 문제가 아니라 **갱신 지점이 둘뿐인 우리 설계의 성질**이다. 세션을 나눠 쓰는 앱이 또 생기면 같은 함정을 밟는다.

⚠ 두 인스턴스(`cs_session_jogak` / `cs_devsession_jogak`)는 **의도적으로 분리**돼 있다 — 합치면 기기 토큰이
로그인 칸에 들어가 `/auth/me`가 200을 주고, 그러면 문의 로그인 필수가 뚫리고 **연령 게이트가 우회되고**
RC가 기기 subject에 붙는다.

✅ **jogak 디스코드 알림은 이제 붙어 있다**(2026-09-07 실측 — 네 앱 모두 `infra.discord: true`). ~~아래는 9/3까지의 상태다.~~
~~⚠ **jogak 문의는 디스코드 알림이 안 간다.**~~(콘솔 대시보드의 "배선 상태"가 이걸 표시한다) `DISCORD_TICKET_WEBHOOK_URL_JOGAK`(또는 앱 공통
`DISCORD_TICKET_WEBHOOK_URL`)이 없어서 `notify`가 no-op이다. 콘솔을 직접 열어보기 전까지
문의가 들어온 줄 모른다 — 웹훅을 넣고 재배포해야 알림이 붙는다.

앱 코드는 `apps` 테이블이 allowlist라 재배포 없이 늘어나지만, **env로 남은 둘은 재배포가 필요하다** —
디스코드 알림 채널(`DISCORD_TICKET_WEBHOOK_URL_*`)과 RC pull 키(`RC_SECRET_API_KEY_*`). 둘 다 없으면 조용히 no-op이라 **안 붙은 줄 모른다.**

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
