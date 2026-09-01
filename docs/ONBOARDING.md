# 새 앱 붙이기

`common_server`에 앱 하나를 연결하는 전 과정. **위에서 아래로 순서대로** 한다.

## 왜 삐걱거렸나 (이 문서의 목적)

지금까지 두 앱(`myword`·`jogak`)을 붙이면서 막힌 지점은 전부 같은 모양이었다.

> **서버 쪽과 앱 쪽을 서로 다른 세션이 하는데, 각자 상대의 상태를 볼 수 없다.**

그래서 이런 일이 실제로 일어났다.

| 실제로 있었던 일 | 겉으로 보인 증상 |
|---|---|
| 서버에 CORS 헤더가 없었다 | 앱에서 요청이 통째로 실패. 서버 로그엔 아무것도 안 남음 |
| SDK에 `login()`이 없었다 | OAuth 클라이언트 ID를 손에 쥐고도 로그인 화면을 못 만듦 |
| `jogak`이 `apps` 테이블에 없었다 | `bootstrap` 404 — "서버가 죽었나?" |
| audience 등록을 안 했다 | 로그인이 전부 `unauthorized` — "토큰이 틀렸나?" |

마지막 두 개가 특히 나쁘다. **앱 등록과 로그인 설정은 별개**인데, 앱만 등록하면 공지·문의는 되고 로그인만 안 된다. 게다가 서버는 로그인 실패 사유를 일부러 뭉갠다(설정 탐색 방지). 앱 로그만 봐서는 원인을 못 찾는다.

**그래서 이 문서의 모든 단계에는 "확인" 명령이 붙어 있다.** 그 출력이 곧 상대 세션에 넘길 증거다. "했다"가 아니라 출력을 붙여넣는다.

---

## 0. 시작 전에 정할 것

| 항목 | 예시 | 나중에 바꾸기 |
|---|---|---|
| `app_code` | `jogak` | ❌ 사실상 불가 (앱 번들·DB·RC에 전부 박힌다) |
| 표시 이름 | 조각 | ✅ 콘솔에서 |
| 로그인 여부 | 있음 / 없음 | ✅ 나중에 추가 가능 (subject는 덧붙이는 구조) |
| 구독 여부 | 있음 / 없음 | ✅ 나중에 추가 가능 |

`app_code`는 `[a-z0-9_]{2,64}`. 앱 번들에 박히는 **공개값**이고 시크릿이 아니다.

**로그인·구독은 나중에 붙여도 된다.** v1(공지+문의)만 먼저 붙이고 출시해도 구조가 꼬이지 않는다 — 그러라고 subject를 나중에 덧붙이는 설계로 만들었다.

---

## 1. 앱 등록 (서버)

```bash
node --env-file=.env.local tools/seed.ts <app_code> "<표시 이름>"
```

멱등하다. 여러 번 돌려도 기존 행을 안 건드린다.

**확인** — 이게 200이면 앱 등록은 끝이다.

```bash
curl "https://common-server.vercel.app/api/v1/bootstrap?app=<app_code>&platform=android&appVersion=0.1.0"
```

```json
{"ok":true,"maintenance":{"active":false},"version":{...},"announcements":[]}
```

> **404가 나오면** 앱이 없거나 비활성이다. 400이 아니라 404인 건 의도다 — 400을 주면 "있는 앱인지"를 탐지당한다.

---

## 2. SDK 복사 (앱)

`common_server/client/` 를 앱의 `src/services/commonServer/` (또는 `lib/common-server/`)로 **복사한다.** monorepo도 npm 패키지도 안 쓴다 — 앱 4~5개 규모에선 오버헤드가 이득보다 크다.

복사본 맨 위에 어느 버전에서 가져왔는지 적는다. `SDK_VERSION` 상수가 그 값이다.

```ts
// common_server/client/ 에서 복사 — SDK_VERSION 2026-08-10
```

의존성 0이라 그대로 돈다. react-native를 import하지 않는다.

```ts
const server = createCommonServer({
  baseUrl: process.env.EXPO_PUBLIC_SERVER_URL ?? '',
  appCode: 'jogak',
  appVersion: Constants.expoConfig?.version ?? '0.0.0',
  platform: Platform.OS,
  storage: AsyncStorage,   // 로그인 쓸 때만. 없으면 세션이 메모리에만 산다
});
```

**확인**

```bash
BASE_URL=https://common-server.vercel.app APP=<app_code> node tools/_dv_sdk.ts
```

앱이 쓰는 것과 **같은 코드**로 서버를 두드린다. 라우트가 멀쩡해도 SDK가 경로·필드명을 틀리면 앱에서만 깨지는데, 이 가드가 그 층을 덮는다.

---

## 3. 부팅 게이트 (앱)

```ts
const boot = await server.fetchBootstrap();
```

**실패해도 앱을 막지 마라.** 서버가 죽었다고 사용자가 앱을 못 쓰면 안 된다. 게이트는 성공했을 때만 적용한다.

| 서버 값 | 앱이 할 일 |
|---|---|
| `maintenance.active` | 점검 화면 (진입 차단) |
| `version.min` 미만 | 강제 업데이트 (진입 차단) |
| `version.latest` 미만 | 소프트 안내 (닫을 수 있게) |
| `announcements` | 공지 목록 + 안읽음 배지 |

읽음 처리는 **앱 로컬**이다(AsyncStorage에 공지 id). 서버에 읽음 테이블을 두지 않는다.

### 활성 하트비트 (DAU) — 2026-09-01

`fetchBootstrap()`은 **세션이 있으면 자동으로 실어 보낸다.** 서버가 그걸로 활성 일자를 기록해
콘솔의 DAU/WAU/MAU가 채워진다. 앱이 별도로 할 일은 **둘이다**:

1. **SDK가 2026-09-01 이상**이어야 한다. 그 전 버전은 토큰을 안 실어 보내므로 그 앱의 DAU는 **0**이다.
2. **부팅 시 세션을 확보**해야 한다. 비회원 앱은 `ensureDeviceSession()`을 `fetchBootstrap()`과
   **병렬로** 쓴다(두 호출 모두 하트비트라 순서를 맞춤 필요가 없고, 직렬하면 부팅만 느려진다).

```ts
const [boot] = await Promise.all([server.fetchBootstrap(), ensureDeviceSession()]);
```

하루에 몇 번을 켜도 1행이다(서버 PK가 멱등). 실패해도 무시된다 — 관측이 부팅을 막지 않는다.

> ⚠ **`deviceId`는 그 자체가 열쇠다.** 그 값을 아는 사람이 그 subject의 문의를 읽는다.
> `expo-crypto`의 `randomUUID()`로 만들고 **SecureStore**에 보관한다(AsyncStorage 금지, `Math.random` 금지).
> 기준 구현체는 `C:\project\link_memo/features/support/server.ts`.

> ⚠ **차단 화면에는 반드시 빠져나갈 길을 둬라.** 스토어 URL이 비어 있는데 버튼을 안 그리면
> 사용자가 앱에 갇힌다. `my_word`에서 실제로 있었던 일이다 — iOS URL이 비어 있고
> 뒤로가기도 막혀 있어서 데드엔드가 됐다. **URL이 없으면 안내문이라도 띄운다.**

---

## 4. 문의 (앱)

```ts
const r = await server.sendInquiry('bug', content);
```

로그인 상태면 자동으로 세션을 실어 본인 문의로 귀속되고, 아니면 익명이다. **호출부는 구분하지 않는다.**

- 본문 최소 `CONTENT_MIN`(5) · 최대 `CONTENT_MAX`(2000). 입력창 `maxLength`를 그보다 크게 두지 마라
- 24시간 접수 캡이 앱마다 있다(기본 30). 초과하면 `rate-limited`
- 저장되는 기기정보는 **platform·appVersion 뿐**이다. IP는 레이트리밋 키로만 쓰고 버린다

### 상태와 답변 (앱이 알아야 할 것)

`getMyInquiries()`가 돌려주는 `status`는 넷이다 — **`reviewing`이 새로 늘었다**(SDK `2026-08-24`).

| status | 뜻 | 앱에서 |
|---|---|---|
| `open` | 접수됨, 아직 안 봄 | "접수됨" |
| `reviewing` | 운영자가 보고 있고 아직 답이 없음 | **"확인 중"** — 이게 없으면 답이 늦을 때 사용자가 무응답으로 읽는다 |
| `replied` | 답변이 달림(`reply`) | "답변 완료" + 본문 노출 |
| `resolved` | 종료 | "완료" |

⚠ **여기 없는 값이 올 수도 있다고 가정하고 분기하라.** 서버가 상태를 늘려도 앱이 안 깨져야 한다
(union에 없는 값은 `default` 가지로 떨어뜨릴 것).

익명 문의에는 `reply`가 달려도 **사용자에게 가지 않는다** — 익명은 돌려줄 경로가 없어서 그 칸이
운영자 내부 메모로 쓰인다. 답변을 받게 하려면 로그인이 필요하다(5번).

### 디스코드 알림 (서버, 선택)

```
DISCORD_TICKET_WEBHOOK_URL_<APP_CODE 대문자>   →  없으면  DISCORD_TICKET_WEBHOOK_URL  →  없으면 no-op
```

⚠ **여기가 유일하게 재배포가 필요한 곳이다.** 앱 코드는 `apps` 테이블이라 재배포 없이 늘어나지만 **알림 채널만은 env**다. 이 비대칭을 모르면 "등록 다 했는데 문의가 안 온다"로 읽는다 — 실제로는 문의가 들어와 있고 알림만 없는 것이다.

```bash
node tools/_vercel_env.ts && npx vercel --prod --yes
```

---

## 5. 로그인 (선택)

로그인이 없는 앱이면 **6번으로 건너뛴다.**

### 5-1. 구글 클라이언트 ID 발급

Google Cloud Console → 사용자 인증 정보. **두 개**가 필요하다.

| | 용도 |
|---|---|
| Android 클라이언트 ID | 패키지명 + SHA-1 지문 등록용. 우리 서버엔 안 넣는다 |
| **웹 클라이언트 ID** | ✅ **이걸 서버 audience에 넣는다** |

🔴 **안드로이드 네이티브 로그인이어도 `idToken`의 audience는 웹 클라이언트 ID다.** 안드로이드 ID를 넣으면 서버가 전부 `unauthorized`로만 답하고, 서버는 사유를 뭉개므로 앱 로그로는 원인을 못 찾는다. **이 문서에서 제일 자주 틀리는 지점이다.**

### 5-2. 서버에 등록

관리자 콘솔 → **앱 설정 → 소셜 로그인** → `google` → 웹 클라이언트 ID 붙여넣기.

콤마로 여러 개 넣을 수 있다(안드로이드·iOS 앱이 서로 다른 웹 클라이언트를 쓰는 경우).

**확인** — 로그인 라우트가 **401**을 주면 정상이다(404가 아니다).

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://common-server.vercel.app/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"app":"<app_code>","provider":"google","idToken":"fake"}'
```

| 응답 | 뜻 |
|---|---|
| **401** | ✅ 앱을 찾았고 토큰 검증에서 떨어졌다 = 설정이 살아 있다 |
| 404 | 앱이 등록 안 됨 → 1번으로 |
| 503 | 서버에 `SESSION_JWT_SECRET`이 없다 → 서버 담당 |

### 5-3. 앱

```ts
// idToken은 앱이 받아온다 — SDK는 의존성 0이라 구글 로그인을 직접 못 한다
GoogleSignin.configure({ webClientId: '...' });   // ← 웹 클라이언트 ID
const { idToken } = await GoogleSignin.signIn();

const r = await server.login('google', idToken);
```

부팅 시 `restoreSession()` 1회. 그 다음부터는 SDK가 알아서 세션을 싣는다.

**세션 폐기 규칙이 비대칭이다** — SDK가 이미 처리하지만 알고는 있어야 한다.

- `offline`이면 **안 지운다.** 지하철에서 앱 켰다고 로그아웃되면 안 된다
- `401`이면 **반드시 지운다.** 안 지우면 "로그인된 것처럼 보이는데 아무것도 안 되는" 상태에 갇힌다

### 5-4. 탈퇴 (Play 정책상 필수)

```ts
await server.deleteAccount();
```

계정을 만드는 앱은 **앱 안에** 삭제 경로가 있어야 하고, **웹에서도** 삭제를 요청할 URL을 스토어 등록정보에 적어야 한다. 나중에 붙이면 심사에서 막히니 로그인과 같이 만든다.

서버는 행을 지우지 않고 가명화한다 — 문의는 보관기간(3년) 동안 남지만 작성자를 되짚을 수 없다.

> ⚠ **탈퇴하면 `subject_id`가 새로 생긴다.** 같은 구글 계정으로 재가입해도 다른 사람이 된다
> (가명화로 UNIQUE가 풀리기 때문이다). 문의 내역은 안 따라온다. **구독이 있으면 8번을 반드시 읽어라.**

**확인**

```bash
BASE_URL=https://common-server.vercel.app APP=<app_code> node tools/_dv_auth.ts
```

---

## 6. 실기기 확인

여기까지 오면 앱이 실제로 돈다. 순서대로 한 번씩.

- [ ] 앱 실행 → 공지 목록이 뜬다
- [ ] 콘솔에서 공지 등록 → 앱 재시작 → 보인다
- [ ] 문의 전송 → 콘솔 **문의** 탭에 뜬다 (+ 디스코드 알림)
- [ ] (로그인) 구글 로그인 성공 → 콘솔 문의에 **이메일이 붙는다**
- [ ] (로그인) 콘솔에서 답변 → 앱 "내 문의 내역"에 뜬다
- [ ] (로그인) 탈퇴 → 다시 로그인 → **문의 내역이 비어 있다** (정상)

> 콘솔에서 `reply`의 의미가 갈린다. 익명 문의에서는 내부 메모지만 **회원 문의에서는 사용자 앱에 그대로 노출된다.** 콘솔이 작성자 배지와 입력 라벨로 구분해 주지만, 운영자가 알고 있어야 한다.

---

## 7. 구독 (선택)

구독이 없으면 여기서 끝이다.

### 7-1. 순서가 있다

```
Play 콘솔 상품 등록  →  RC 프로젝트/엔타이틀먼트  →  우리 서버 시크릿  →  앱 SDK
```

앞 단계가 안 끝나면 뒤 단계는 검증할 수단이 없다. **건너뛰고 나중에 맞추려 하면 어디서 끊겼는지 못 찾는다.**

자세한 절차와 함정은 `store-iap-setup` 스킬에 있다. 한국 규제(청약철회·미성년자 결제·해지 경로 표시)는 `payment-security-compliance` 스킬이다. **Play 콘솔 상품 등록 전에** 후자를 먼저 돌려라 — 요건이 상품 구성(base plan + offer)에 영향을 준다.

### 7-2. 우리 서버 쪽

관리자 콘솔 → **구독** 탭.

1. **웹훅 URL** 복사 → RC 대시보드 Integrations → Webhooks
2. **시크릿 `발급`** → 43자 값이 **한 번만** 표시된다 → 같은 화면의 Authorization에 붙여넣기

서버는 sha256만 저장하고 원문을 버린다. 다시 못 본다(RC가 원본을 들고 있으니 우리가 남길 이유가 없다).

**확인** — RC 대시보드에서 테스트 이벤트 전송 → 콘솔 **웹훅 이력**에 `무시 / test-event`로 뜬다. 뜨면 인증이 통한 것이다.

3. **RC secret API key** → Vercel env `RC_SECRET_API_KEY_<APP_CODE 대문자>` (예: `RC_SECRET_API_KEY_JOGAK`)

이건 웹훅과 **반대 방향**이다. 웹훅은 RC가 우리를 부르고, 이 키는 우리가 RC에 물어본다.
웹훅은 5회 재시도 후 **포기**하므로, 이 키가 없으면 유실된 사용자는 영구히 `pro`가 아니다(`docs/PLAN.md` Phase 9.1).

```bash
node tools/_vercel_env.ts && npx vercel --prod --yes    # env는 재배포해야 적용된다
```

⚠ 이건 **그 RC 프로젝트의 모든 구독자를 읽을 수 있는 시크릿**이다. 웹훅 시크릿과 달리 DB가 아니라 env에 있고,
따라서 **앱을 늘릴 때마다 재배포가 필요하다**(디스코드 웹훅과 같은 비대칭).
키가 없어도 서버는 깨지지 않는다 — pull이 통째로 no-op일 뿐이다.

### 7-3. 앱 쪽

🔴 **`Purchases.logIn(subject_id)`를 결제 화면 열기 전에 반드시 호출한다.**

RC가 익명 ID(`$RCAnonymousID:...`)를 만들게 두면 **"이 구독자가 저 사용자인지" 매칭할 방법이 영영 없다.** 가장 비싼 실수다.

```ts
const r = await server.login('google', idToken);
if (r.ok) await Purchases.logIn(r.subject.id);   // ← 이거
```

서버는 `app_user_id`가 UUID가 아니면 거부하고 콘솔 이력에 `anonymous-app-user-id`로 남긴다. 조용히 넘기지 않는다.

### 7-4. 광고·기능 게이트

```ts
const r = await server.fetchEntitlements();
const pro = r.ok && r.entitlements.pro?.active;

// 구매 성공 직후 · 구매 내역 복원 — 이 두 곳에서만
const r2 = await server.fetchEntitlements({ fresh: true });
```

- **`active`만 캐시하지 마라.** `expiresAt`을 같이 저장하고 그때까지만 유효로 봐야 한다. 안 그러면 만료 후에도 영원히 pro다
- 유예 중(`inGracePeriod`)이면 `expiresAt`이 유예 종료 시각으로 온다. 그 전에 광고를 켜면 안 된다
- 미구독자도 **200에 빈 객체**다. 404가 아니다 — 서버 오류와 미구독이 구분돼야 광고 여부를 판단할 수 있다
- 활성 구독이 없으면 서버가 RC에 직접 물어본다. `fresh: true`면 60초로 줄어든다 —
  **결제 직후와 복원 버튼에서만 켜라.** 포그라운드 복귀·주기 갱신에 켜면 쿨다운의 존재 이유가 사라진다
- 🔴 **결제 직후 잠깐 `active=false`가 정상일 수 있다.** Play가 첫 결제를 확정하기 전 90초짜리
  기간을 발급하고, 확정 후 `RENEWAL`이 한 달로 정정한다(실측: 정정까지 17분). 그동안 서버는
  10분마다 재확인한다. **앱은 이걸 "구매 실패"로 단정하지 말고 "처리 중"으로 다뤄라**

### 7-5. 탈퇴 + 구독의 함정 🔴

**탈퇴해도 구글 구독은 계속 청구된다.** 우리가 해지시킬 수 없다.

- 탈퇴 화면에 **경고 + Play 구독 관리 링크**를 넣어라. 없으면 "탈퇴했는데 돈이 나간다" 문의가 온다
- 재가입하면 `subject_id`가 바뀌어서 구독이 안 붙는다. 로그인 후 `active`가 false면 **`restorePurchases()`를 호출**해라 — RC가 소유자를 옮기고 서버에 TRANSFER가 온다
- **RC의 이전은 공유가 아니라 이동이다.** 같은 기기에서 다른 계정으로 로그인하면 구독이 그쪽으로 넘어가고 원래 계정은 잃는다. 가족 공유를 기대한 사람에게 조용히 뺏기는 게 최악이라 **구독 화면에 명시**하는 게 좋다

**확인**

```bash
node tools/_dv_purchase.ts                                          # 판정·상태전이 (DB 불필요)
BASE_URL=https://common-server.vercel.app node tools/_dv_purchase.ts   # + 라우트
```

---

## 8. 증상 → 원인

두 세션이 서로를 못 볼 때 가장 시간을 많이 쓴 것들.

| 증상 | 1순위 원인 | 확인 |
|---|---|---|
| 모든 요청 실패, 서버 로그 없음 | CORS (또는 `baseUrl` 미설정) | `curl -X OPTIONS` 로 `access-control-*` 헤더 확인 |
| `bootstrap` 404 | 앱 미등록/비활성 | 1번 |
| 로그인만 `unauthorized` | audience 미등록 **또는 안드로이드 ID를 넣음** | 5-2 확인 명령. idToken의 `aud` 클레임과 대조 |
| 로그인 `not-configured`(503) | 서버 `SESSION_JWT_SECRET` 없음 | 서버 담당 |
| 문의는 들어오는데 알림이 없음 | 앱별 디스코드 웹훅 env 없음 **(재배포 필요)** | 4번 |
| 결제는 됐는데 권한이 없음 | `Purchases.logIn` 누락 | 콘솔 웹훅 이력 `anonymous-app-user-id` |
| 결제는 됐는데 `entitlement_ids`가 빔 | RC에서 상품을 엔타이틀먼트에 **attach 안 함** | 콘솔 웹훅 이력 `no-entitlement-ids` |
| 테스트 결제가 권한을 안 줌 | 라이선스 테스터 결제도 SANDBOX로 온다 | `RC_SANDBOX_GRANT=all` (출시 전 끌 것) |
| 결제 후 한참 지나도 권한이 안 붙음 | 웹훅 유실 + `RC_SECRET_API_KEY_*` 없어서 pull이 no-op | 7-2 3번. 키를 넣고 **재배포** |
| 해지했는데 계속 `pro` | 유실된 EXPIRATION. 웹훅 후 pull이 다음 이벤트에서 고친다 | 콘솔 웹훅 이력에 `PULL` 행이 있는지 |
| 결제 직후 잠깐 미구독으로 보임 | **Play가 확정 전 90초짜리 기간을 준다.** 확정 후 `RENEWAL`이 한 달로 정정한다(실측 17분) | 콘솔 웹훅 이력의 `→ 만료` 값이 두 번 바뀌는지 |
| 재가입 후 구독이 사라짐 | `subject_id`가 바뀜 | `restorePurchases()` 호출 |
| 문의 답변을 썼는데 앱에 안 보임 | 익명 문의였다(그 칸은 내부 메모다) | 콘솔 문의 상세의 작성자 배지가 '익명'인지 |
| 콘솔에서 상태를 바꿨는데 안 먹음 | 저장을 안 눌렀다(모달은 저장 버튼으로만 커밋한다) | 모달 하단 "저장하지 않은 내용이 있습니다" |
| 문의 건수가 실제와 다름 | 가드(`_dv_public`)가 만든 문의는 기본 제외된다 | 문의 탭의 "가드 문의 N건 보기" 버튼 |
| DAU가 계속 0 | 앱 SDK가 2026-09-01 미만 — 부팅에 세션을 안 실어 보낸다 | 콘솔 개요의 "활성 계측 미수집" 알림 |
| DAU는 찍히는데 일부 사용자가 안 잡힘 | 비회원 앱인데 `ensureDeviceSession()`을 안 부른다(세션이 없으면 토큰도 없다) | 3번 |
| 요일 차트가 "수집 중"에서 안 넘어감 | 요일당 2일치(2주)를 모아야 그린다 | 수집 경과일 표시(개요 우측 "수집 N일차") |
| 콘솔 "사용자" 수와 DAU가 안 맞음 | 같은 것을 안 센다 — 앞은 누적 가입자, 뒤는 그날 접속자 | 정상 |

> **막히면 콘솔 대시보드의 "배선 상태"를 먼저 본다.** 디스코드 알림·RC 웹훅 시크릿·RC pull 키·
> Upstash·Sentry는 **없어도 서버가 조용히 잘 돈다** — 그래서 안 붙은 줄 모른다. 이 표가 그걸 드러낸다.
> 같은 화면 위쪽의 운영 알림은 문의 방치·캡 도달·웹훅 거부를 서버 판정으로 띄운다.

**공통 규칙: 우리 서버가 실패 사유를 뭉개는 건 의도다.** 로그인·웹훅 실패는 전부 같은 401을 준다(설정 탐색 방지). **진단은 관리자 콘솔에서 한다** — 웹훅은 이력에 사유가 남고, 로그인은 audience 설정을 눈으로 보면 된다.

---

## 9. 세션 간에 넘길 것

앱 쪽 세션에 넘길 때 **이 표를 채워서** 준다. 지금까지 막힌 건 대부분 이 중 하나가 비어 있어서였다.

```
베이스 URL   : https://common-server.vercel.app
app_code     : <값>          ← bootstrap 200 확인함
SDK 버전     : <SDK_VERSION>  ← client/ 에서 복사할 것
로그인       : 있음 / 없음
  구글 audience 등록됨: 예 / 아니오   ← login 401 확인함(404 아님)
구독         : 있음 / 없음
  RC 웹훅 연결됨: 예 / 아니오        ← 테스트 이벤트 200 확인함
알림         : 디스코드 웹훅 있음 / 없음
```

**"등록했다"가 아니라 확인 명령의 출력을 붙여넣는다.** 그게 이 문서 전체의 요점이다.

---

## 관련 문서

- `docs/PLAN.md` — 설계와 로드맵. **변경 전에 먼저 읽을 것**
- `CLAUDE.md` — 규약·배포·명령
- `docs/HANDOFF_MYWORD.md` — 앱 세션에 붙여넣는 프롬프트 예시
