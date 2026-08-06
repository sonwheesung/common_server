# my_word 연동 핸드오프 프롬프트

`C:\project\my_word\my_word` 에서 Claude 세션을 열고 아래를 그대로 붙여넣으면 된다.

---

## 붙여넣을 프롬프트

```
공통 서버(common_server)가 배포됐다. 이 앱을 거기에 붙이는 작업을 해줘.

## 배경

지금 이 앱의 문의하기는 **배구게임 서버**에 얹혀 있다(`/api/ticket/anon`, `proj: 'myword'`).
앱을 여러 개 만들 계획이라 공통 서버를 따로 만들었고, 이제 그쪽으로 옮긴다.
동시에 지금 **로컬 상수에 하드코딩된 버전 게이트**(`LATEST_VERSION`)를 서버가 관리하도록 옮긴다.
이게 이번 작업의 진짜 목적이다 — 스토어 심사를 기다리지 않고 서버에서 업데이트 안내·점검을 켤 수 있게 하는 것.

## 공통 서버 사실 (확정, 이미 배포·검증 완료)

- 베이스 URL: https://common-server.vercel.app
- 이 앱의 app_code: `myword` (서버 `apps` 테이블에 등록됨)
- 소스: `C:\project\common_server` — 설계는 `docs/PLAN.md`, 규약은 `CLAUDE.md`

### API 계약 2개가 전부다

**GET `/api/v1/bootstrap?app=myword`** — 앱 부팅 시 1회. 점검·버전게이트·공지를 한 번에.
```json
{
  "ok": true,
  "maintenance": { "active": false },
  "version": { "min": null, "latest": null, "androidUrl": null, "iosUrl": null },
  "announcements": [
    { "id": "uuid", "kind": "notice", "title": "...", "body": "마크다운", "pinned": false, "startsAt": "ISO" }
  ]
}
```
`maintenance.active`가 true면 `{ active: true, title, body }` 형태다.
미등록/비활성 앱은 404.

**POST `/api/v1/tickets`** — 익명 문의 접수(단방향, 답변 경로 없음).
```json
{ "app": "myword", "category": "bug|suggestion|question|etc",
  "content": "5~2000자", "device": { "platform": "android", "appVersion": "1.0.0" } }
```
성공 `{ "ok": true }` · 400 본문 짧음 · 404 미등록 앱 · 429 한도초과 · 500 서버오류.
**ticketId를 돌려주지 않는다**(조회 경로가 없어서 클라가 쓸 데가 없다).

이전 계약과 달라진 점: 경로 `/api/ticket/anon` → `/api/v1/tickets`, 필드명 `proj` → `app`.

## 해야 할 일

### 1. SDK 복사
`C:\project\common_server\client\{index.ts,types.ts}` 를 `src/services/commonServer/` 로 **복사**한다.
(monorepo·npm 패키지 안 쓴다 — 앱 4~5개 규모에선 오버헤드가 이득보다 크다)
복사본 상단에 "common_server/client 에서 복사, 2026-08-06" 주석을 남긴다.
SDK는 `createCommonServer({ baseUrl, appCode, appVersion, platform })` 팩토리를 export하고
`fetchBootstrap()` / `sendInquiry()` / `isConfigured()` / `compareVersions()` 를 준다.
**절대 throw하지 않고 실패를 타입으로 반환한다** — 지금 supportService와 같은 규약이라 화면 수정이 적다.

### 2. 문의하기 전환
- `src/services/supportService.ts` 를 SDK 위 얇은 래퍼로 바꾼다. **export 시그니처(`sendInquiry`,
  `isConfigured`, `SupportCategory`, `SupportResult`)는 유지**해서 `SupportScreen.tsx` 수정을 최소화한다.
- `src/constants/appConfig.ts` 의 `SUPPORT_PROJ` → `APP_CODE`(값 `'myword'` 그대로).
- `.env` / `.env.example` 의 `EXPO_PUBLIC_SERVER_URL` 을 `https://common-server.vercel.app` 로 교체.
- `__tests__/supportService.test.ts` 를 새 계약(URL·필드명)에 맞춰 갱신한다. 기존 테스트 케이스
  (짧은 본문, trim, 429, 500, 오프라인, 타임아웃 signal, 미설정 빌드)는 **전부 살린다**.

### 3. 버전 게이트를 서버로 이관 ← 이번 작업의 핵심
현재 `src/services/versionService.ts` 는 `appConfig.LATEST_VERSION` 하드코딩을 본다. 이걸 bootstrap 응답으로 바꾼다.
- `version.latest` 보다 낮으면 → 기존 `UpdateModal` (건너뛰기 가능한 소프트 안내). 기존 `VERSION_SKIP_KEY` 로직 유지.
- `version.min` 보다 낮으면 → **강제 업데이트**. 닫을 수 없어야 하고 앱 진입을 막아야 한다(새 UI 필요).
- `maintenance.active` 면 → 점검 화면. 역시 진입 차단. `title`/`body` 를 그대로 보여준다.
- 스토어 링크는 `version.androidUrl` 우선, 없으면 기존 `STORE_URL` 상수 폴백.
- `appConfig.LATEST_VERSION` 은 제거한다(진실이 두 곳에 있으면 반드시 어긋난다).

### 4. 공지사항 화면 (신규)
- bootstrap의 `announcements` 를 목록으로 보여준다. `pinned` 우선, 그다음 `startsAt` 내림차순
  (서버가 이미 그 순서로 준다 — 클라에서 다시 정렬하지 말 것).
- `startsAt` 을 "등록일"로 표시한다.
- **읽음 처리는 앱 로컬(AsyncStorage)** 에 읽은 공지 id 배열로 관리한다. 서버에 읽음 API는 없고,
  만들 계획도 없다(비회원 앱이라 매달 사용자가 없다).
- 안 읽은 공지가 있으면 설정/홈에 배지를 띄운다.
- `body` 는 마크다운 원문이다. 마크다운 렌더러를 새로 넣을지, 일단 plain text로 보여줄지는 네가 판단해서 제안해라.

## 반드시 지킬 것

1. **bootstrap 실패로 앱을 막지 마라.** 네트워크 오류·서버 다운·타임아웃이면 그냥 평소대로 앱을 쓰게 둔다.
   점검·강제업데이트 게이트는 **조회에 성공했을 때만** 적용한다. 서버가 죽었다고 사용자가 앱을 못 쓰면 안 된다.
2. **`EXPO_PUBLIC_*` 는 빌드 시점에 번들로 인라인된다.** `.env` 를 바꾸면 반드시 재빌드해야 반영된다.
   개발 중 값이 안 바뀌는 것처럼 보이면 이걸 먼저 의심해라.
3. **배구 서버(`C:\project\volleyball`)를 건드리지 마라.** 이미 스토어에 나간 my_word 버전은 계속
   배구 서버의 `/api/ticket/anon` 을 호출한다. 거기 `ANON_TICKET_PROJECTS` 에서 `myword` 를 빼면
   구버전 사용자의 문의가 죽는다. 구버전 수명이 다할 때까지 그대로 둔다.
4. **개인정보를 더 보내지 마라.** 서버가 저장하는 건 platform·appVersion 뿐이다. 기기 식별자·osVersion·
   사용자 이름 같은 걸 추가로 실어 보내지 말 것. 문의는 익명 단방향이고 그게 설계 의도다.
5. bootstrap은 **부팅 시 1회**만 호출한다. 화면 전환마다 부르지 마라.

## 검증

- `npx tsc --noEmit` 통과
- `npm test` — supportService 테스트 갱신 후 전부 통과
- 실제 서버 대상 수동 확인:
  - 문의 접수 → 성공 토스트. 서버 관리자 콘솔(https://common-server.vercel.app/ops-4b7e21)에서 접수 확인 가능
  - 공지 노출 → 관리자 콘솔에서 공지 하나 발행 후 앱 재시작 시 뜨는지
  - 점검 모드 → 콘솔에서 켜고 앱 재시작 시 진입 차단되는지 (**확인 후 반드시 다시 끌 것**)
- 서버를 껐다고 가정한 상황(잘못된 URL로 빌드)에서 앱이 정상 동작하는지 — 제약 1번 확인

작업 전에 계획을 먼저 세워서 보여줘.
```

---

## 서버 쪽에서 미리 해두면 좋은 것

- **Discord 문의 알림**: `DISCORD_TICKET_WEBHOOK_URL_MYWORD` 를 Vercel env에 넣으면 접수 즉시 채널로 온다.
  미설정이면 완전 no-op이라 지금은 문의가 와도 알림이 없다 — 콘솔을 직접 봐야 한다.
- **Upstash 레이트리밋**: 현재 미설정이라 IP 리미터가 무력이다. 실질 방어는 앱별 24h 캡(기본 30건) 하나뿐.
  앱을 실제로 배포하기 전에 붙이는 걸 권한다.
- **스토어 URL·버전**: 관리자 콘솔 "설정" 탭에서 `androidStoreUrl`, `latestVersion` 을 채워둬야
  앱의 업데이트 안내가 동작한다. 비어 있으면 게이트가 없는 것으로 처리된다(의도된 기본값).
