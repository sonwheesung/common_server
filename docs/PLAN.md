# 공통 서버 (common_server) — 구축 플랜

> 여러 로컬 앱이 공유하는 백엔드. **v1 범위는 문의하기 + 공지사항**.
> 쿠폰·광고제거는 §8 로드맵에 설계만 확정해 두고, v1 스키마가 그쪽으로 **확장만(Expand-only)** 되도록 짠다.

작성일: 2026-08-06

---

## 1. 배경 — 지금 뭐가 있나

| 위치 | 상태 |
|------|------|
| `C:\project\volleyball\server` | Next.js 16 + Vercel + Supabase(Drizzle). 실서비스 중. 모든 테이블에 `proj_code` FK가 있지만 `lib/proj.ts`의 `PROJ_CODE` env로 **1배포 = 1게임** 고정 |
| `C:\project\volleyball\server\app\api\ticket\anon\route.ts` | 공통 서버의 씨앗. body의 `proj`를 **env allowlist**로 검증 + 프로젝트별 익명 유저 1행 + IP 레이트리밋 + 24h 총량 캡 |
| `C:\project\my_word\my_word` | Expo RN 앱. 로그인 없음. `src/services/supportService.ts`가 **이미 배구 서버의 `/api/ticket/anon`을 `proj: 'myword'`로 호출 중** |
| `C:\project\common_server` | 빈 레포(`.git`만) — 여기에 만든다 |
| `C:\project\my_word\my_word_back` | 빈 디렉터리 (사용 안 함) |

즉 "공통 서버"는 맨땅이 아니라, **배구 서버에 임시로 얹혀 있던 익명 문의를 제자리로 옮기고 정식화하는 작업**이다.

### 확정된 결정

1. **신규 앱 전용 별도 배포.** 배구 서버는 그대로 둔다 (결제 원장·5년 보존 데이터 리스크 회피). 검증된 패턴만 이식.
2. **광고제거는 RevenueCat 경유** (Phase 7).
3. **v1은 문의 + 공지.** 쿠폰은 이후.
4. **Supabase 새 프로젝트 분리.**

---

## 2. 설계 축 — "주체(subject)" 문제

기능 4개를 신원 요구사항으로 갈라보면 이렇게 나뉜다.

| 기능 | 신원 필요? | 이유 |
|------|-----------|------|
| 공지사항 | **불필요** | 읽기 전용 브로드캐스트. 읽음 여부는 앱 로컬(AsyncStorage)에서 관리 → 서버 부담 0 |
| 문의하기 | **불필요**(단방향이면) | 익명 접수 + 관리자만 읽음. 단 "답변 확인"을 하려면 필요 |
| 쿠폰 | **필수** | "유저당 1회" 게이트를 걸 대상이 있어야 함 |
| 광고제거 | **필수** | 엔타이틀먼트 소유자가 있어야 함 |

**그래서 v1(공지+문의)은 신원 없이 간다.** 지금 my_word가 쓰는 방식 그대로 — 서버조차 누가 보냈는지 모른다(개인정보 최소수집).

Phase 6에서 `subjects` 테이블 하나를 추가하면 쿠폰·광고제거·문의답변이 **한꺼번에** 열린다:

```
subjects
  id          uuid pk
  app_code    → apps.app_code
  kind        'device' | 'user'
  device_id   앱 최초 실행 시 생성한 UUID (SecureStore 보관)
  provider    google | apple        (kind='user'만)
  provider_id
  UNIQUE(app_code, kind, key)
```

- **비회원 앱(my_word)**: `POST /v1/devices` → 서버가 subject 생성 + 서명 토큰 발급 → SecureStore 저장 → 이후 Bearer.
  무인증으로 두면 남의 `device_id`를 사칭해 쿠폰·광고제거를 가로챌 수 있으므로 **토큰은 필수**다.
- **로그인 앱**: 로그인 시 device subject를 user subject로 **승격/병합**.
- 결과: 쿠폰·엔타이틀먼트·문의는 전부 `subject_id` 하나에만 매달린다. 회원/비회원 코드 경로가 갈라지지 않음.

v1에서는 이 테이블을 **만들지 않는다**. 대신 `tickets`에 나중에 `subject_id uuid null`을 붙이는 것만으로 이어붙게 설계한다(배구 서버가 실제로 이런 식으로 진화했고, 같은 Expand-only 규약을 따른다).

---

## 3. 아키텍처

```
Expo 앱들 ──HTTPS──▶ common_server (Vercel, Next.js 16 App Router)
  myword                    │
  (신규앱들)                 ├── Supabase Postgres (신규 프로젝트, Drizzle)
                            ├── Upstash Redis (IP 레이트리밋)
                            ├── Discord Webhook (신규 문의 알림, 앱별 채널)
                            └── Sentry (배포 환경에서만 전송)

volleyball/server ── 그대로 유지 (자체 Supabase, 자체 배포)
```

### 배구 서버에서 이식할 패턴 (재발명 금지)

| 패턴 | 원본 | 왜 |
|------|------|-----|
| `afterSafe()` | `lib/afterSafe.ts` | 응답 후 처리(Discord 알림)를 서버리스 freeze로 유실하지 않게 |
| fail-closed 시크릿 게이트 | `lib/auth.ts` | 프로덕션에서 `ADMIN_TOKEN` 짧으면 관리자 기능 전면 차단 |
| env를 **호출 시점**에 읽기 | `lib/auth.ts` 주석 | 모듈 로드 시 캐시하면 배포 env 변경이 안 먹음 |
| IP RL + DB 총량 캡 2중 방어 | `api/ticket/anon` | Upstash 미설정 시 RL은 fail-open이라 DB 캡이 실질 방어선 |
| Sentry 환경 게이트 | `lib/sentryGate.ts` | 로컬 dev 500이 운영 Sentry로 폭주한 실제 사고 이력 |
| `_dv_*` 검증 스크립트 | `tools/_dv_*.ts` | 라우트별 라이브 가드 |

### 배구 서버와 **다르게** 가는 것

| 항목 | 배구 | common_server | 이유 |
|------|------|---------------|------|
| 프로젝트 식별 | `PROJ_CODE` env 고정 | 요청의 `app` 파라미터 | 1배포 N앱 |
| allowlist | env `ANON_TICKET_PROJECTS` | **DB `apps` 테이블** | 앱 추가에 재배포 불필요 |
| API 경로 | `/api/ticket` (무버전) | `/api/v1/tickets` | 계약 깨는 변경 시 병행 운영 여지 |
| 유저 모델 | `users` 필수 FK | v1은 없음 | 익명 우선 |

---

## 4. 데이터 모델 (v1)

Drizzle + Supabase Postgres. 4개 테이블.

```ts
// apps — 앱 레지스트리. 공개 라우트의 allowlist 근거.
apps {
  appCode        text pk        // 'myword', 'volleyball'(이관 시), ...
  name           text
  active         boolean = true // false면 공개 라우트 전부 404
  ticketDailyCap integer = 30   // 24h 문의 총량 캡(앱별)
  createdAt      timestamptz
}

// appSettings — 앱별 1행. 부팅 게이트(강제업데이트/점검)의 진실.
appSettings {
  appCode          text pk → apps
  minVersion       text?  // 미만이면 진입 차단(강제 업데이트)
  latestVersion    text?  // 미만이면 소프트 안내
  androidStoreUrl  text?
  iosStoreUrl      text?
  maintenance      boolean = false
  maintenanceTitle text?
  maintenanceBody  text?
  updatedAt        timestamptz
}

// announcements — 기간제 노출. pinned 우선 정렬.
announcements {
  id        uuid pk
  appCode   text → apps
  kind      text = 'notice'   // notice | event | update
  title     text
  body      text              // 마크다운 원문
  pinned    boolean = false
  startsAt  timestamptz = now()
  endsAt    timestamptz?      // null = 무기한
  createdAt / updatedAt
  INDEX(appCode, startsAt)
}

// tickets — 익명 단방향 접수. reply는 Phase 6(답변 확인 경로 생길 때) 활성.
tickets {
  id         uuid pk
  appCode    text → apps
  category   text        // bug | suggestion | question | etc
  content    text        // ≤2000자
  status     text = 'open'  // open | replied | resolved
  reply      text?          // 관리자 답변(v1은 내부 메모 성격)
  repliedAt  timestamptz?
  platform   text?          // ios | android — 어떤 환경에서 난 문제인지
  appVersion text?
  createdAt  timestamptz
  INDEX(appCode, createdAt)
}
```

**개인정보 최소수집**: `osVersion`·IP·기기 지문은 저장하지 않는다(배구 익명 문의와 동일 판단). 저장하는 건 플랫폼·앱버전뿐.

**보관·파기(PIPA)**: 문의 3년 후 파기. 만료 공지는 종료 후 1년 뒤 파기. cron이 일 1회 수행(§Phase 5).

---

## 5. API 계약 (v1)

### 공개

```
GET  /api/health
     → { ok, db: 'up'|'down', now }

GET  /api/v1/bootstrap?app=myword
     앱 부팅 시 단 1회 호출. 점검·버전게이트·활성 공지를 한 번에.
     → {
         ok: true,
         maintenance: { active: false } | { active: true, title, body },
         version: { min, latest, androidUrl, iosUrl },
         announcements: [{ id, kind, title, body, pinned, startsAt }]  // 최대 50
       }
     app 미등록/비활성 → 404

POST /api/v1/tickets
     body: { app, category, content, device?: { platform, appVersion } }
     → { ok: true }                       // ticketId 반환 안 함(조회 경로 없음 = 불필요한 식별자 노출 회피)
     → 400 bad-request | 404 not-found | 429 rate-limited | 500 error
```

`bootstrap`은 앱 로컬 신뢰를 금지한다 — 진입 게이트는 **이 응답으로만** 결정한다. 스토어 강제업데이트에 의존하지 않고 DB로 우회할 수 있는 게 이 설계의 요점.

### 관리자 (`Authorization: Bearer <ADMIN_TOKEN>`, 16자 미만이면 전면 차단)

```
GET|POST|PATCH   /api/admin/apps
GET|PATCH        /api/admin/settings?app=
GET|POST|PATCH|DELETE /api/admin/announcements?app=
GET|PATCH        /api/admin/tickets?app=&status=
```

### 크론 (Vercel `CRON_SECRET`)

```
GET /api/cron/purge     // 매일 1회 — 보관기간 경과분 파기
```

---

## 6. 방어 설계 (무인증 공개 write)

`POST /api/v1/tickets`는 인증이 없다. 배구와 같은 **2중 방어**:

1. **IP 레이트리밋** (Upstash) — 5회/600초. Upstash 미설정 시 fail-open이라 이것만으로는 부족.
2. **앱별 24h 총량 캡** (DB count 기반, fail-closed) — Upstash 없이도 동작하는 **실질 방어선**.
   캡의 목적은 가용성 보장이 아니라 **피해량 제한**이다(스크립트는 어떤 값이든 소진시킬 수 있으므로).
   기본 30/일, `apps.ticketDailyCap`으로 앱별 조정.
3. 본문 5~2000자, 카테고리 allowlist, `app` DB allowlist.

Discord 웹훅 URL은 **DB에 넣지 않는다**(관리자 콘솔에 시크릿이 노출됨). env 규약 유지:
`DISCORD_TICKET_WEBHOOK_URL_MYWORD` → 없으면 `DISCORD_TICKET_WEBHOOK_URL`로 폴백 → 그것도 없으면 완전 no-op.

---

## 7. 구현 단계

> **진행 상황 (2026-08-06)** — Phase 0~5 완료·배포·검증 끝. 남은 것은 Phase 6(my_word 연동).
> 프로덕션 https://common-server.vercel.app · 가드 결과: 공개 10/10 · 관리자 14/14 (프로덕션 기준)
>
> | Phase | 상태 |
> |---|---|
> | 0 스캐폴드·인프라 | ✅ Supabase(ap-northeast-2) + Next 16 + Vercel 배포 |
> | 1 앱 레지스트리·공지 | ✅ 4테이블 push · `myword` 시드 · `/api/v1/bootstrap` |
> | 2 문의 접수 | ✅ `/api/v1/tickets` + 앱별 24h 캡 + Discord 알림(myword 채널) |
> | 3 관리자 콘솔 | ✅ `/ops-4b7e21` 4탭 |
> | 4 클라이언트 SDK | ✅ `client/` |
> | 5 운영 하드닝 | ⚠️ 크론·가드 완료. **Sentry·Upstash 미설정** — 레이트리밋이 fail-open이라 현재 방어는 DB 일일 캡 단독 |
> | 6 my_word 연동 | ⬜ 미착수 |


### Phase 0 — 스캐폴드 · 인프라 (반나절)
- Supabase 신규 프로젝트 생성, Transaction 풀러(:6543) 문자열 확보
- `common_server/` Next.js 16 + TS + Drizzle 스캐폴드 (배구 `package.json` 의존성 셋 재사용)
- `db/index.ts`(postgres.js, `prepare:false`), `drizzle.config.ts`, `.env.example`
- `GET /api/health` → Vercel 배포 + 도메인 확인
- **완료 기준**: 배포된 URL에서 `/api/health`가 `db: 'up'`

### Phase 1 — 앱 레지스트리 + 공지 (1일)
- 스키마 4테이블 작성 + `drizzle-kit push` (마이그레이션은 Session/Direct :5432로)
- `apps` / `appSettings` 시드: `myword`
- `GET /api/v1/bootstrap` — 점검·버전·공지
- **완료 기준**: `curl /api/v1/bootstrap?app=myword`가 공지 목록 반환, 미등록 앱은 404

### Phase 2 — 문의 접수 (1일)
- `POST /api/v1/tickets` + 레이트리밋(`lib/ratelimit.ts`) + 앱별 캡
- `lib/notify.ts` Discord 알림 + `lib/afterSafe.ts`
- **완료 기준**: 접수 → Discord 채널에 알림 도착, 캡 초과 시 429

### Phase 3 — 관리자 콘솔 (1.5일)
- `/ops-<랜덤>` 단일 페이지. 상단 **앱 선택 드롭다운** + 탭 4개
  - 공지: 목록·작성·수정·기간/고정 토글
  - 문의: 목록·필터(앱/상태/기간)·상태 변경·답변 입력
  - 설정: minVersion·latestVersion·스토어 URL·점검 on/off
  - 앱: 등록·활성 토글·캡 조정
- `requireAdmin` fail-closed
- **완료 기준**: 콘솔에서 공지 발행 → bootstrap 응답에 즉시 반영

### Phase 4 — 클라이언트 SDK (0.5일)
- `common_server/client/` 에 TS 파일 3개: `bootstrap.ts` / `tickets.ts` / `types.ts`
- 모듈은 **throw 하지 않는다** — 실패를 타입으로 반환(my_word `supportService`의 기존 규약 유지)
- 배포 방식: **앱마다 `src/services/commonServer/`로 복사** + 버전 주석.
  앱 4~5개 규모에선 monorepo/npm 패키지 오버헤드가 이득보다 크다.

### Phase 5 — 운영 하드닝 (1일)
- `GET /api/cron/purge` + `vercel.json` 크론 등록 (문의 3년, 만료 공지 1년)
- Sentry + 환경 게이트(`sentryGate.ts` 이식)
- `tools/_dv_bootstrap.ts` · `_dv_ticket.ts` · `_dv_admin.ts` 라이브 가드
- **완료 기준**: 가드 3종 전부 통과

### Phase 6 — my_word 연동 (1일)
- `EXPO_PUBLIC_SERVER_URL`을 common_server로 교체, `proj` → `app` 필드명 정리
- 기존 `supportService.ts`를 SDK로 교체 (계약이 거의 동일해 화면 수정 최소)
- **공지사항 화면 신규**: 부팅 시 bootstrap 호출 → 점검/강제업데이트 게이트 + 공지 배지, 읽음 id는 AsyncStorage
- ⚠️ **이미 스토어에 배포된 my_word 버전은 계속 배구 서버를 호출한다.** 배구의 `/api/ticket/anon`은 구버전 수명이 다할 때까지 유지하고, `ANON_TICKET_PROJECTS`에서 `myword`를 빼지 않는다.
- **완료 기준**: 신규 빌드에서 문의 접수 + 공지 노출 정상

---

## 8. 로드맵 (v1 이후)

### Phase 7 — subject 모델
`subjects` 테이블 + `POST /api/v1/devices`(토큰 발급) + `tickets.subjectId` nullable 추가.
이게 들어오는 순간 **문의 답변 확인 · 쿠폰 · 광고제거**가 동시에 가능해진다.

> **✅ device subject 구현(2026-08-14)** — 첫 사용처는 `linkmemo`(로그인 없는 앱의 문의 귀속).
> `POST /api/v1/devices` body `{ app, deviceId(UUID) }` → `subjects(kind='device', provider='device',
> provider_id=deviceId)` upsert(멱등) + 로그인과 동일한 세션 토큰 발급. IP 레이트리밋 `device` 버킷.
> deviceId 형식은 UUID로 강제(쓰레기 값 차단). 이메일 없음 — 서버가 아는 건 무작위 UUID뿐이라
> 개인정보 최소수집 원칙이 유지된다. 클라이언트는 SDK `registerDevice()`(SDK_VERSION 2026-08-14).
> user 승격(디바이스→구글)은 미구현 — 필요해질 때.

### Phase 8 — 쿠폰
```
coupons            (appCode, code, rewardType, rewardPayload, targetSubjectId?, startsAt, endsAt, disabled)
couponRedemptions  (appCode, couponId, subjectId)  UNIQUE ← 1회 게이트
```
보상은 **엔타이틀먼트/기간제 혜택**으로 한정하는 게 안전하다(예: 광고제거 30일). 공통 서버에 재화 지갑을 두면 앱마다 다른 화폐 정의·환불 정책·동시성 잠금까지 딸려온다.
핵심 규약(배구 `lib/coupon.ts`): **검증 + redemption INSERT + 지급을 단일 트랜잭션**으로. 두 트랜잭션을 이으면 "기록만 남고 미지급" 크래시 창이 생긴다.

### Phase 9 — 구독·엔타이틀먼트 (RevenueCat) — ✅ 서버 구현 완료 (2026-08-10)

조각(`jogak`)의 월 구독(`pro`)이 첫 사용처다. 아래 원안과 달라진 점만 적는다(구현: `lib/revenuecat.ts`·`lib/entitlement.ts`).

- **`active`를 저장하지 않는다.** `expiresAt`·`graceUntil`·`revokedTxnId`를 두고 읽을 때 계산한다.
  갱신 계열(INITIAL·RENEWAL·UNCANCELLATION)은 만료를 `max()`로만 밀어 **교환법칙**이 성립 →
  도착 순서가 뒤바뀌어도 같은 상태로 수렴한다(배구의 가법 원장이 순서역전에 안전했던 것과 같은 성질).
  만료를 **앞당길 수 있는** PRODUCT_CHANGE·EXPIRATION만 덮어쓰기라 `lastEventAt` 가드가 붙는다.
- **회수는 거래에 묶는다**(`revokedTxnId = lastTxnId`일 때만 비활성). 영구 플래그로 두면
  한 기간분만 환불되고 구독이 살아 있을 때 이후 갱신이 와도 영원히 비활성 —
  **"돈은 내는데 pro가 아닌"** 상태가 된다. 거래 비교면 새 갱신에서 자동으로 풀린다.
- **판정·상태전이를 순수 함수로** 뺐다(`decideEvent`·`nextState`). 가드가 DB 없이 순서역전·환불 후 갱신을
  검증할 수 있어야 한다 — DB 안에 숨은 판단은 검증되지 않는다.
- **웹훅 시크릿은 sha256만 저장**하고 콘솔이 32바이트를 생성한다. 이 DB의 첫 자격증명이라,
  읽히는 사고가 "문의 본문 유출"에서 "엔타이틀먼트 위조 가능"으로 등급이 오르지 않게.
  sha256은 KDF가 아니므로 사람이 지은 값은 받지 않는다.
- **엔타이틀먼트 키는 RC의 `entitlement_ids`를 그대로** 쓴다. 상품→키 매핑을 우리가 들면
  RC의 attach 누락(빈 배열)이 우리 매핑에 가려진다. `apps.entitlementKeys`는 오타 필터일 뿐이다.
- **탈퇴한 주체의 웹훅은 200**(ignored). 영원히 실패할 조건에 5xx를 주면 RC가 백오프로 재전송하며
  에러 지표를 같은 이벤트 복제로 채운다.
- **TRANSFER 필수.** 탈퇴 후 재가입하면 `subject_id`가 새로 생긴다(가명화로 UNIQUE가 풀리므로).
  구독은 Play 계정 소유라 앱이 `restorePurchases()`를 부르면 RC가 소유자를 옮긴다. 처리 안 하면
  "돈은 나가는데 pro가 아닌" 상태가 유지된다. RC의 이전은 **공유가 아니라 이동**이다.

#### Phase 9.1 — pull 폴백 (2026-08-19)

**웹훅이 유일한 입력이었다.** RC는 실패 시 5회(5·10·20·40·80분) 재시도하고 **포기한다**. 포기하면
그 사용자는 영구히 `pro`가 아니고 복구 경로는 사용자가 스스로 "구매 내역 복원"을 누르는 것뿐이다 —
돈 낸 사람이 그 버튼이 자기 문제의 답인 줄 알 리 없다. RC 공식 권고도 "웹훅을 받으면
`GET /subscribers`로 다시 당겨 동기화하라"다. 구현: `lib/rcPull.ts`.

두 자리에서 당긴다.

| 자리 | 조건 | 쿨다운 |
|---|---|---|
| `GET /api/v1/entitlements` | **활성 엔타이틀먼트가 하나도 없을 때** = 부정 답을 주기 직전 | 6시간 (`?fresh=1`이면 60초) |
| RC 웹훅 수신 후(`afterSafe`) | 항상 | 60초 |

- **읽기 경로가 미도래를, 웹훅 경로가 유실을 담당한다.** 유실된 EXPIRATION("해지했는데 영원히 pro")은
  읽기 경로가 못 잡는다 — 활성일 때는 pull하지 않기 때문이다. 그래서 웹훅 후 pull이 따로 필요하다.
- **상태 전이는 웹훅과 공유한다.** 스냅샷은 이벤트가 아니라 상태라 `decideEvent`를 못 쓴다.
  입력 파싱만 `decideSnapshot`으로 가르고 `nextState()`는 같은 것을 쓴다 — 두 경로가 각자
  상태를 계산하면 "웹훅으로는 맞는데 pull로는 틀린" 버그가 생긴다.
- **`eventAt`은 쓰는 시각이 아니라 RC 요청 발사 시각(t1)이다.** 안 그러면 되감기가 난다:
  `t1 pull 발사 → t2 웹훅 도착 → t3 pull 응답 반영`에서 t1 데이터가 t2를 덮어쓴다.
  t1로 찍으면 기존 `lastEventAt` 가드가 알아서 버린다 — **새 가드를 만들지 않았다.**
- **쿨다운은 Postgres**(`subjects.rc_pulled_at`)다. Upstash는 미설정이고 `checkLimit`은 fail-open이라
  거기 얹으면 "미설정 = 쿨다운 없음"이 되어 **인프라가 흔들릴 때 정확히 RC 호출이 터진다.**
  조건부 `UPDATE ... WHERE rc_pulled_at < now() - interval RETURNING`은 쿨다운과 동시성 락을
  한 문장에 담는다(Redis 카운터는 read-then-write 사이가 벌어져 동시 요청이 둘 다 통과할 수 있다).
- **실패하면 쿨다운을 되돌린다**(`PULL_RETRY_SEC` = 2분). 스탬프는 claim 때 찍히므로 롤백이 없으면
  답을 못 받고도 6시간 잠긴다 — 이 작업이 고치려던 상황이 다른 이유로 재현된다.
  ⚠ "실패"는 네트워크·타임아웃·5xx·인증 실패뿐이다. **200 "구독 없음"은 정상 답**이라 쿨다운을 태운다.
  아니면 미구독자 전원이 2분마다 RC를 때린다.
- **감사행 멱등키는 결정적 합성키**(`pull:<subject>:<key>:<exp>:<grace>:<renew>`). 같은 스냅샷을
  반복 pull해도 UNIQUE가 한 행으로 접으므로 "왜 권한이 바뀌었나"는 남고 테이블은 안 붓는다.
- **실패는 조용하다.** RC가 죽어도 `/api/v1/entitlements`는 기존 DB 상태로 200을 준다. 500을 주면
  앱은 unreachable로 보고 캐시를 유지하는데, 500이 잦으면 관측이 오염된다.

env: `RC_SECRET_API_KEY_<APPCODE>` → `RC_SECRET_API_KEY` → **없으면 pull 전면 no-op**(기존 동작 유지).
앱별 키는 `lib/notify.ts`의 디스코드 웹훅과 같은 규칙이고, 같은 비대칭(**env라서 재배포 필요**)을 진다.

남은 것: 조각 서버용 `/api/internal/entitlements`(서비스 토큰) — 조각 서버가 생길 때.

### Phase 9 원안 — 광고제거 (RevenueCat)
```
entitlements (appCode, subjectId, key='remove_ads', source, storeTxnId, expiresAt?, revokedAt?)
POST /api/v1/purchase/confirm          — 구매 직후 클라 확인
POST /api/webhooks/revenuecat          — 서버 진실(멱등, rcEventId dedupe)
```
- 비회원은 RC 익명 ID(`$RCAnonymousID`)로 잡히고, 기기 교체 시 **스토어 복원**이 1차 경로 · 서버는 감사/미러.
- 로그인 앱은 서버 엔타이틀먼트가 진실 → 계정 이동해도 유지.
- 환불 웹훅 → `revokedAt` 세팅(회수).
- `purchase_event` append-only 감사 로그는 배구 스키마를 거의 그대로 이식.

### Phase 10 — (선택) 배구 이관
배구의 공지·문의를 common으로 옮길지 재검토. 이관 이득 < 이중 운영 비용이면 안 한다.

---

## 9. 환경변수

```bash
# DB (Supabase 신규 프로젝트)
DATABASE_URL=postgresql://...pooler.supabase.com:6543/postgres   # 런타임=Transaction 풀러
# 마이그레이션만 :5432 (Session/Direct)로 drizzle-kit push

# 관리자 — 16자 미만이면 관리자 기능 전면 차단(fail-closed)
ADMIN_TOKEN=

# 레이트리밋 (없으면 fail-open → DB 캡이 방어)
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=

# 알림 (비우면 완전 no-op)
DISCORD_TICKET_WEBHOOK_URL=
DISCORD_TICKET_WEBHOOK_URL_MYWORD=

# 크론
CRON_SECRET=

# 관측 (배포 환경에서만 전송)
SENTRY_DSN=
SENTRY_TRACES_SAMPLE_RATE=0.1

# Phase 9
# RC_WEBHOOK_SECRET=
# RC_REST_API_KEY=
```

---

## 10. 디렉터리

```
common_server/
├── app/
│   ├── api/
│   │   ├── health/route.ts
│   │   ├── v1/{bootstrap,tickets}/route.ts
│   │   ├── admin/{apps,settings,announcements,tickets}/route.ts
│   │   └── cron/purge/route.ts
│   └── ops-<랜덤>/{page.tsx,layout.tsx}
├── db/{index.ts,schema.ts,migrations/}
├── lib/{admin,afterSafe,apps,notify,observability,ratelimit,retention,sentryGate}.ts
├── client/{bootstrap.ts,tickets.ts,types.ts}   ← 앱에 복사해 쓰는 SDK
├── tools/_dv_*.ts
├── docs/PLAN.md
└── {drizzle.config.ts, vercel.json, .env.example}
```

---

## 11. 확인이 필요한 리스크

- **Vercel Hobby 플랜은 상업적 사용이 제한된다.** 앱이 광고·결제로 수익화하면 Pro 전환이 필요할 수 있다. 배구 서버 운영 경험에 비춰 이미 정리된 사항이면 무시.
- **Supabase 무료 티어는 활성 프로젝트 2개까지**, 1주간 요청이 없으면 pause. 배구 + common으로 정확히 2개 — **이후 앱은 반드시 `app_code`로 이 하나에 태워야 한다**(앱마다 프로젝트를 파면 즉시 한도 초과).
- **`ops-<랜덤>` 경로는 보안 장치가 아니다.** 실제 방어는 `ADMIN_TOKEN` fail-closed. 경로는 크롤링 노출을 줄이는 부수 조치일 뿐.
```
