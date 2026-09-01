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

#### Phase 9.2 — 실결제 1건이 가르쳐준 것 (2026-08-19)

조각의 첫 실결제에서 "만료가 50초로 저장됐다"는 보고가 왔다. **서버 버그가 아니었다.** 실측 순서:

| 시각 | 일 | 만료 |
|---|---|---|
| 14:06:21 | 결제 | |
| 14:07:00 | `INITIAL_PURCHASE` 웹훅 | **14:07:51** (90초) |
| 14:07:03 | `PULL` | 14:07:51 (RC도 같은 값) |
| 14:07:51 | Play 결제 확정 | |
| 14:24:19 | `RENEWAL` 웹훅 | **2026-09-19T14:07:51** ✅ |

**Play는 첫 결제를 확정하기 전 90초짜리 기간을 발급하고, 확정 후 `RENEWAL`로 한 달을 준다.**
웹훅과 pull이 두 번 다 RC와 정확히 일치했다 — 필드 매핑도 맞았다(`entitlements.pro.expires_date`).

그래서 드러난 진짜 문제는 **17분의 공백**이다. 그동안 결제자는 미구독자였고, 읽기 경로 pull은
직전 pull이 찍은 6시간 스탬프에 막혀 있었다. `RENEWAL`이 유실됐다면 **6시간 잠긴다.**

- **쿨다운을 "우리가 얼마나 틀렸을 수 있나"에 맞춘다**(`pullCooldownFor`). 갈림길은 하나 —
  *갱신되기로 돼 있는데(`willRenew`) 만료돼 있는가.* 그렇다면 이벤트를 놓쳤을 수 있고,
  틀렸을 때의 비용이 **돈 낸 사람이 막히는 것**이라 10분마다 물어볼 값어치가 있다.
  해지한 사람과 미구독자는 답이 바뀔 일이 없으니 6시간. 이탈자가 영원히 10분마다 때리지 않도록
  만료 후 24시간(`PULL_EXPIRED_WINDOW_SEC`) 창을 둔다.
- **`purchase_events.expires_at`** — 이 이벤트가 만들어낸 만료를 1급 필드로 남긴다.
  이번에 원인을 못 가른 이유가 그것이었다(원문은 `raw`에 있었지만 조회·표시가 안 됐다).
  그래서 상태 전이를 감사행 **삽입 전에** 계산한다(읽기·순수 계산뿐 — 쓰기 순서는 그대로).

🔴 **"최소 주기보다 짧은 만료를 버려라"는 넣지 않았다.** 90초는 **정상 값이었다.**
그런 가드가 있었으면 유일한 진실을 버렸을 것이고, 더 나쁘게는 RC가 만료를 정당하게 **앞당길 때**
(PRODUCT_CHANGE·조기 만료) 우리가 더 긴 옛 값을 붙들어 과다 지급이 된다 —
`overwrite` 모드를 만든 이유가 바로 그것이다. **RC와 갈리는 방향으로는 가드를 걸지 않는다.**

남은 것: 조각 서버용 `/api/internal/entitlements`(서비스 토큰) — 조각 서버가 생길 때.

### Phase 11 — 관리자 콘솔 2차 (2026-08-24)

배구 서버 운영 콘솔(2,512줄 + 관리자 라우트 21개)을 전수 대조해 옮겨온 것들. **가져오지 않은 것도 적어둔다** —
저쪽이 다크 고정인 것은 두 번의 팔레트 상향 끝에 나온 타협이고, 우리는 이미 라이트 기본 + 명시 토글이라
그 결론의 한 발 앞이다. 옮기면 후퇴다.

#### 고친 결함 (콘솔이 조용히 틀리고 있던 것들)

| | 증상 | 원인 | 수정 |
|---|---|---|---|
| 앱 스코프 | 콘솔이 A앱을 보는 중에 B앱 티켓 id로 답변이 박혀도 성공 | `admin/tickets` PATCH의 `where`에 `appCode`가 없었다(GET은 있었다 — 누락이지 의도가 아니다) | `and(appCode, id)` + `app` 파라미터 필수. 없으면 400, 타앱이면 404 |
| 거짓 완료 | 데이터가 오기 전에 "새로고침됨" 토스트 | `void loadApps(); void loadApp(); flash(...)` — await가 없었다 | `await` 후 토스트, 연타 차단은 ref(state면 콜백이 재생성돼 의존성이 흔들린다) |
| 죽은 새로고침 | 구독·로그인설정 탭에서 새로고침이 **아무 일도 안 함** | 그 탭들은 `[api]`로 스스로 조회하는데 `api`가 `token`에만 의존 | `nonce` 축 — `api = useCallback(.., [token, nonce])`. 탭 코드를 안 건드리고 전부 재조회된다 |
| 날것 에러 | 화면에 `bad-request`·`Failed to fetch` | reason 코드를 그대로 throw + fetch를 try로 안 감쌈 | `REASON_KO` 매핑 + fetch throw를 status 0으로 정규화 |

#### 문의 — 상태값과 답변 처리

- **`reviewing`(확인 중)을 추가했다.** 없으면 "읽었고 조사 중인데 아직 답을 못 쓴" 상태를 표현할 수 없어,
  목록을 다시 열 때마다 어디까지 봤는지 처음부터 다시 읽는다. **미처리 = 대기 + 확인 중**이고,
  뱃지·대시보드·기본 필터가 전부 같은 정의(`isPending`)를 쓴다.
- ⚠ `replied`/`resolved`는 **개명하지 않았다.** `v1/tickets/mine`이 이 값을 앱에 그대로 내려주므로
  배구처럼 `answered`로 바꾸면 이미 나간 앱의 분기가 깨진다. 추가는 하되 개명은 안 한다(Expand-only).
  SDK의 `MyInquiry.status` 유니온에만 `reviewing`을 더했다(`client/types.ts`, SDK `2026-08-24`).
- **상태를 입력의 부수효과로 바꾸지 않는다.** 종전엔 메모를 쓰면 자동으로 `replied`가 됐다 —
  "적어두기만 하고 아직 답은 안 함"을 표현할 수 없었다. 콘솔은 항상 상태를 명시해 보내고,
  라우트의 폴백은 상태를 **안 보낸 호출에 한해서만** 동작한다.
- 답변 입력이 `<input>` 한 줄이었다(`maxLength=4000`인데). 회원 문의는 그 값이 앱에 그대로 노출되는데
  문단을 나눌 수가 없었다 → 행 클릭 → 모달 상세 + `textarea` + 상태 select + **단일 저장**(답변·상태 함께 커밋).
- 유형 × 상태 2축 필터, 기본값 **미처리**. '전체'가 기본이면 처리 끝난 문의가 상단을 채워
  "지금 손이 필요한 게 뭔가"에 답하지 못한다.

#### 새 화면

- **사용자(`/api/admin/subjects`)** — `subjects` 테이블이 있는데 조회 화면이 없었다. 회원 문의가 와도
  "이 사람이 누구인지"를 볼 수 없었다. 상태 필터·페이지네이션·문의 수·구독 상태.
  `provider_id` 원문은 내려보내지 않는다(운영 판독에 쓸 일이 없고, 유출 시 계정 특정에 쓰인다).
- **오류·웹훅 감사(`stats.errors`)** — `purchase_events`에 `outcome`/`reason`을 남기고 있었지만
  **사유별 집계 화면이 없었다**. "결제가 안 붙었다"가 웹훅 미수신인지 수신 후 거부인지는 여기서만 갈린다.
- **운영 알림(`stats.alerts`)** — 판정은 **서버가** 한다. 화면이 판정하면 임계가 UI 코드에 흩어지고,
  화면을 안 열면 아무도 모른다. 한 곳에 두면 나중에 크론이 같은 함수를 불러 디스코드로 민다.
  판정: 앱 비활성 · 점검 모드 · 문의 방치(48h/72h) · 문의 캡 도달/근접 · 웹훅 거부 24h · RC 시크릿 미설정 · 디스코드 미설정.

#### 배선 상태 — 조용한 no-op을 화면에 드러낸다

`stats.infra`는 디스코드 웹훅 · RC pull 키 · RC 웹훅 시크릿 · Upstash · Sentry가 **붙었는지 여부만** 준다.
이 다섯은 없어도 서버가 조용히 동작해서 **안 붙은 줄 모른다**(CLAUDE.md의 경고가 정확히 이것이다).
붙은 즉시 확인된 실제 결과: `myword`는 RC 시크릿 미설정, `jogak`은 디스코드 채널 없음 — 둘 다 문서에만 있던 사실이다.

🔴 **값은 절대 내려보내지 않는다.** boolean만 나가는지 가드가 검사한다(`_dv_admin`: "infra는 boolean만").

#### 가드 문의 격리

로컬 dev가 프로덕션 DB를 쓰므로 `tools/_dv_public.ts`가 만든 문의가 운영 문의와 같은 테이블에 쌓인다.
본문의 `[_dv_public]` 접두사로 **기본 제외**하되, **가린 건수를 함께** 보여준다(`devCount`).
숨기고 말이 없으면 숫자가 조용히 달라져 판독을 그르친다 — 숨김이 아니라 **제외 + 고지**다.

#### 형식

마지막 갱신 시각(`14:22 기준`) · 새로고침 스피너 + 폭 고정 · 공용 `Modal`(ESC·푸터 규격·푸터 좌측 인라인 오류) ·
로고 = 홈 버튼 · 활성 메뉴 좌측 액센트 바 · 표 자체가 가로 스크롤 컨테이너(카드째 스크롤하면 제목·필터가 밀려 나간다) ·
CSV(BOM + 파일명에 필터 조건) · `BRAND` 객체 1곳 집중(이식 = BRAND + globals.css 토큰 + NAV) ·
미가용 지표는 지우지 않고 **블로커를 이름으로** 붙여 남긴다.

### Phase 12 — 활성 지표(DAU/WAU/MAU) (2026-09-01)

콘솔에 "오늘 몇 명이 앱을 켰나"가 없었다. 배구 서버에는 있는데 여기엔 없던 이유는 **신원이 아니라 신호**가 없었기 때문이다.

#### 출발점: 이미 있던 것과 없던 것

식별 축은 이미 있었다 — `subjects.kind='device'`(`POST /v1/devices`, Phase 7). 이메일 없이도 기기 UUID로 귀속된다.
없던 건 **활성 신호**다. 두 가지가 겹쳐 있었다:

1. **`lastSeenAt`이 사실상 설치 시각이었다.** 유일한 writer가 `ensureSubject`/`ensureDeviceSubject`의 upsert인데,
   앱은 기기 등록을 평생 1회만 부른다(`lib/ratelimit.ts`의 device 버킷 주석이 그 전제로 쓰여 있다).
   확인 결과 **subjects 38건 중 37건이 `last_seen_at - created_at < 5분`**이었다.
   그래서 Phase 11이 대시보드에 올린 "최근 14일 접속"은 실제로는 **"최근 14일 신규 설치"**였다 — 화면이 조용히 거짓말하고 있었다.
2. **컬럼 하나로는 과거를 복원할 수 없다.** 그걸 고쳐 매 부팅마다 갱신해도, 주체당 한 칸이라 덮어써진다.
   매일 켠 사람도 "오늘" 버킷에만 잡히고 과거로 갈수록 과소 집계된다. 날짜 축은 최신 쪽으로 **단조** 편향돼서
   시각 축(하루 안에서 흩어짐)보다 왜곡이 크고 눈에 안 띈다. 배구 서버가 요일 차트에서 겪고 `user_active_day`를 판 것과 같은 함정.

#### 설계

**`subject_active_day (app_code, subject_id, day)` — PK가 곧 멱등키다.**
`day`는 timestamp가 아니라 **KST로 접은 `'YYYY-MM-DD'` 문자열**이다. 하루를 어느 시간대로 자를지는 운영 판단이라
DB(UTC)에 맡기지 않고 `lib/activityMath.ts`에 명시한다. 개인정보는 주체 id + 날짜뿐(IP·기기지문 없음), 보관 400일.

**하트비트는 세 곳.** `bootstrap`(토큰이 실려 오면) · `devices` · `auth/login`.
왜 셋인가: 앱은 `registerDevice`와 `fetchBootstrap`을 **병렬로** 쏘므로 첫 실행·재설치 때는 bootstrap에 아직 토큰이 없다.
bootstrap만 두면 신규 사용자의 첫날이 통째로 사라진다. PK가 멱등을 보장하므로 셋 다 찍혀도 하루 1행이다.

**⚠ bootstrap에서만 토큰이 선택이다.** 다른 라우트는 "헤더가 있는데 무효면 401"인데(익명 강등 금지 — Phase 7),
bootstrap은 무효 헤더를 **조용히 무시하고 200**을 준다. 여기는 진입 게이트라서, 세션 만료가
점검·강제업데이트 판정을 막으면 안 된다. 서버가 점검을 걸려는 순간 구버전 사용자가 그걸 못 받는 게 가장 나쁜 실패다.
이 비대칭은 `tools/_dv_public.ts`가 못박는다.

**쓰기는 1일 1회.** `onConflictDoNothing().returning()`이 **새 행을 실제로 넣었을 때만** `lastSeenAt`을 갱신한다.
부팅마다 UPDATE가 나가지 않는다.

**순수 계산을 파일로 분리했다**(`lib/activityMath.ts`). "어떤 일별 카운트가 어떤 요일 평균이 되는가"가 이 기능의
전부인데 async DB 함수 안에 묻히면 가드가 소스 정규식으로밖에 못 본다. 분리하니 `tools/_dv_activity.ts`가
DB 없이 **실제로 호출해서** 검증한다(16 케이스).

#### 정직함이 이 기능의 본체다

숫자보다 "모았나"가 먼저다. 거짓말이 나오는 경로 셋을 각각 막았다:

| 거짓말 | 막는 장치 |
|---|---|
| 빠진 날을 표본에서 빼면 평균이 위로 편향 | 창 전체 날짜를 **0으로 메워** 집계에 넘긴다 |
| 표본 0인 요일을 0으로 그리면 "아무도 안 왔다"로 읽힘 | `avg: null`로 내려보내고 화면은 `—` |
| 수집 전인데 차트를 그리면 우연을 경향으로 읽음 | 게이트 축이 `samples`가 아니라 **수집 경과일**(`min(day)` 기준) |

세 번째가 특히 함정이다. `samples`는 "그 요일에 해당한 **날짜 수**"라서 활성자가 0명이어도 창 길이만큼 채워진다
— 그걸로 판정하면 수집 0일에도 항상 참이 되어 차트가 "월요일 최다"라고 단언한다(배구 서버 실사고).

같은 이유로 **"주체는 있는데 활성 기록이 0행"이면 `activity_uncollected` 알림**을 띄운다. DAU 0이
진짜 0인지 계측이 아직 안 붙은 건지 구분되어야 한다 — 조용한 no-op을 화면에 드러낸다는 기존 규약의 적용이다.

#### 앱 쪽 대가 (미완)

DAU는 **앱이 SDK ≥ 2026-09-01로 재배포되어야** 생긴다. `fetchBootstrap`이 세션을 실어 보내는 게 그 버전부터다.

- `linkmemo` · `idearepository`(2026-08-14) · `jogak`(2026-08-19) — SDK 재복사만 하면 된다. `ensureDeviceSession()`은 이미 있다.
- **`myword`(2026-08-06)는 재복사로 안 끝난다.** 최초판이라 세션·기기 subject 자체가 없다:
  ① SDK 재복사 ② `expo-secure-store`·`expo-crypto` 추가(deviceId·세션 토큰은 자격증명이라 AsyncStorage 금지,
  `randomUUID`도 암호학적 난수여야 한다 — deviceId가 곧 열쇠다) ③ `client.ts`에 storage 주입
  (없으면 매 실행 `registerDevice`를 다시 불러야 하는데 device 레이트리밋이 10회/600초·IP당이라 걸린다)
  ④ `BootstrapContext`의 `Promise.all`에 `ensureDeviceSession()` 추가.

  ⚠ myword는 이게 DAU보다 큰 의미가 있다 — 지금 문의 14건이 **전부 익명**이라 답변을 돌려줄 경로가 없다.
  deviceId가 붙어야 Phase 11의 `reviewing`/`replied` 상태값이 myword에서 의미를 갖는다.

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
- ~~**Supabase 무료 티어는 활성 프로젝트 2개까지**, 1주간 요청이 없으면 pause. 배구 + common으로 정확히 2개 — **이후 앱은 반드시 `app_code`로 이 하나에 태워야 한다**(앱마다 프로젝트를 파면 즉시 한도 초과).~~
  → 🔴 **정정 (2026-08-24 대시보드 실측)**: 이 서술은 **틀렸다.** 운영 프로젝트는 무료 조직이 아니라
  **Pro 플랜 조직(`WheeSungSon`)에 있고, Pro는 프로젝트 개수 제한이 없다.** 실제 제약은 *개수*가 아니라
  **활성 프로젝트당 Micro compute 요금**이다. 실측값·조직 인벤토리 정본은
  `C:\project\common\BUSINESS_INFO.md` §5.1.
  - `WheeSungSon`(**Pro**): common-server(ap-northeast-2, 활성) · volleyball(ap-northeast-2, 활성) ·
    chaekdam(ap-northeast-1, ⏸paused) · sadojeon(ap-southeast-1, ⏸paused) — **4개**
  - `Vivace Staging`(**Free**): jogak-stg · volleyball-stg — 2개(무료 한도는 여기서만 유효)
  - 청구(2026-08-07~09-07): Pro $25.00 + Compute $10.70 − Credits $10.00 = 현재 **$25.70**, 예상 **$38.08**
  - **신규 활성 프로젝트 1개 ≈ +$10/월** — $10 compute 크레딧은 기존 2개가 이미 다 쓴다.
  - ⚠ **Spend cap 켜짐** — 포함 할당량 초과 시 추가 과금 대신 **프로젝트가 unresponsive/read-only로 떨어진다.**
  - **결론은 그대로 유지된다**: 새 앱은 여전히 `app_code`로 common_server 하나에 태우는 게 맞다.
    근거가 "무료 한도"에서 **"한계비용 0 + 운영 단일화"**로 바뀔 뿐이다.
- **`ops-<랜덤>` 경로는 보안 장치가 아니다.** 실제 방어는 `ADMIN_TOKEN` fail-closed. 경로는 크롤링 노출을 줄이는 부수 조치일 뿐.
```
