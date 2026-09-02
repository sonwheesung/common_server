---
name: reload-docs
description: Re-read this project's design docs (CLAUDE.md spine + docs/NEXT.md + docs/PLAN.md + the relevant docs/*.md) to restore design context — especially after a context compaction, when the docs/ content read earlier is gone. Also carries the "진행형 상태 문서는 말하기 직전에 다시 읽는다" rule (§1.7): this repo is a **hub for 4 app sessions**, so app SDK versions, per-app status, and live metrics go stale within the hour — never answer those from memory, and never relay another session's claim without checking. Invoke when the user asks to "문서 다시 읽어", "문서 리로드", "설계 문서 읽어", "컴팩트 후 문서", "reload docs", right after a /compact, or before summarizing app/session/deploy status. A SessionStart(compact) hook reminds the assistant to run this automatically after compaction.
---

# reload-docs — 설계 문서 재적재 (common_server)

> **왜**: 이 저장소는 설계 결정·제외 결정·검증 루틴이 `CLAUDE.md`(규약) + `docs/*.md`에 박혀 있다.
> **컴팩트가 일어나면 앞서 읽어둔 docs/ 본문이 컨텍스트에서 사라져** 설계 근거 없이 결정하게 된다.
> 이 스킬은 그 공백을 다시 채운다.
>
> 참고: `CLAUDE.md`와 메모리(`MEMORY.md`)는 매 세션 자동 주입돼 컴팩트 후에도 남는다 →
> **실제 공백은 `docs/`**. 그래서 `docs/`를 다시 읽는 게 핵심이다.
>
> ⚠ 이 프로젝트엔 `docs/README.md` 색인이 **없다**. **`CLAUDE.md`가 곧 색인**이다 —
> 문서 목록·명령·구조·연동 앱 표가 전부 거기 있다. 색인을 찾지 말고 CLAUDE.md를 색인으로 써라.

## 실행 순서

1. **척추 먼저 (필수)** — 한 번에 전체 지형을 잡는다:
   - `docs/NEXT.md` — **가장 먼저.** 미결 목록. "지금 어디까지 왔고 다음이 뭔지"의 정본이다.
     끝난 항목은 지우거나 PLAN으로 옮기는 규칙이라, 여기 남아 있으면 **아직 안 끝난 것**이다.
     (파일이 없다면 미결이 없다는 뜻 — 그것도 정보다.)
   - `CLAUDE.md` — 규약(env 호출 시점 읽기·fail-closed/open·afterSafe·미등록 앱 404·활성은
     `subject_active_day`에서·앱 스코프 write 등)·배포표·명령·연동 앱 표. 자동 주입돼 있어도
     **결정 직전이면 한 번 더 짚는다**(규약은 "재발명 금지" 목록이라 어기면 조용히 망가진다).
   - `docs/PLAN.md` — 설계 정본. 특히 §2 주체(subject) 문제 · §5 API 계약 · §6 무인증 write 방어 ·
     §7~8 단계(최신은 **Phase 12 활성 지표**) · §9 환경변수 · §11 리스크.

1.5. **★ 공용 문서 재적재 (`C:\project\common`) — 항상** — 여러 프로젝트가 공유하는 기준 문서를 함께 읽는다.
   `C:\project\common` 아래 **콘텐츠 `.md` 전부**(`ls C:/project/common/*.md` 로 목록 확인 후 Read):
   - `BUSINESS_INFO.md` — 사업자·서비스 정보 단일 출처. **커밋 금지 파일.**
   - `COMMIT_CONVENTION.md` — 커밋 메시지 규약(`YYMMDD :: [태그] 한국어 요약`).
   - **`PLAY_CONSOLE_STATUS.md`** — 지금 무엇이 어느 트랙에 나가 있나. **§1.8이 이걸 갱신한다.**
   - `CLOSED_TESTING.md` · `DOC_SYSTEM.md` · `GLOBAL_DATA_COMPLIANCE.md` · `PLAY_RELEASE_AUTOMATION.md` 등.
   - `.claude/`(스킬·에이전트 정의)는 도구라 제외 — 호출 시 로드된다.
   > 왜: 한 프로젝트 세션이 **크로스-프로젝트 사실**(계정 상태·법적 정보·릴리스 절차)을 낡은 기억으로
   > 오보하기 쉽다(배구 실패: 계정·결제 상태 오보 2026-08-11).

1.7. **★ 진행형 상태 — 답하기 전에 매번 다시 본다 (기억 금지)** 🔴
   **이 저장소에서 가장 잘 상하는 항목이다.** 여긴 **1배포 N앱의 허브**라, 상태의 절반이
   *다른 세션과 운영 DB*에서 온다. 세션 중 이미 읽었어도 **말하기 직전에 다시 확인한다.**

   | 말하려는 것 | 근거를 어디서 | 왜 기억이 상하나 |
   |---|---|---|
   | 앱별 SDK 복사본 버전·연동 상태 | `CLAUDE.md` 연동 앱 표 + **그 세션에 직접 물어본다** | 앱 세션이 복사·배포하면 **이쪽 표가 뒤늦게 따라간다** |
   | 남은 일·차단된 항목 | `docs/NEXT.md` | 다른 세션이 대기 중일 수 있다(예: linkmemo가 결정 하나로 vc11을 잡고 있었다) |
   | DAU·문의 수·배선 상태 | **`/api/admin/stats`를 그 자리에서 호출** | 몇 시간 전 스냅샷을 "현재"로 말하게 된다 |
   | 배포 여부·env 설정 여부 | `npx vercel ls` / `stats`의 `infra`·`infraEnv` | env는 **재배포해야 적용**된다 — "넣었다"와 "적용됐다"가 다르다 |
   | 스토어 트랙·게시 여부·심사 상태 | **`C:\project\common\PLAY_CONSOLE_STATUS.md`**, 오래됐으면 §1.8로 갱신 | 게시는 콘솔에서 일어나고 **아무 세션에도 전달되지 않는다** |

   > **왜(2026-09-01 실전 실패 3건 — 전부 `docs/MULTI_SESSION.md §5`에 있다)**
   > ① **2.5시간 묵은 DAU 스냅샷**을 "현재 0"이라고 앱 세션에 통보 → 실제로는 5였다.
   > ② 스토어 빌드 시점을 **추측**으로 단정 → 앱 세션이 정정했다(결론은 맞았는데 근거가 틀렸다).
   > ③ 다른 세션의 주장("프로덕션에 나가 있다")을 **검증 없이 중계** → 알파 트랙이었다.
   > **규칙**: 상태를 한 줄이라도 말할 때 그 줄의 **근거를 그 자리에서** 확인하고 쓴다.
   > 다른 세션이 준 사실은 **누가·언제 말했는지**를 함께 적는다. 중계는 확인이 아니다.

1.8. **★ Play Console 현황 갱신 (크롬) — 조건부** 🔴
   정본은 **`C:\project\common\PLAY_CONSOLE_STATUS.md`**. 그 문서가 갱신 절차·앱 ID·읽기 전용 규칙을 다 갖고 있다.

   **갱신한다** — 아래 중 하나라도 해당하면:
   - 그 문서의 `확인 시각`이 **24시간보다 오래됐고**, 이번 작업이 출시·트랙·앱 상태를 말하거나 판단에 쓴다
   - 앱 세션에 게시·트랙 관련 메시지를 보내려 한다
   - 사용자가 "올렸다 / 심사 넣었다 / 게시됐나"를 언급했다

   **안 한다** — 서버 내부 작업만 하는 중이면. 앱당 10~20초씩 드는 조회다.

   절차 요약(상세는 그 문서 §3): **새 탭**을 만들고(사용자 탭을 옮기지 않는다 — 2026-09-01 실제 사고) →
   앱별 `releases/overview`를 열고 → **스켈레톤이 사라질 때까지 5~15초 기다렸다** 읽고 → 표와
   `확인 시각`을 함께 고치고 → 탭을 닫는다.

   🔴 **읽기 전용이다.** `출시 시작`·`검토를 위해 제출`·`게시`·`프로덕션으로 승격`·등록정보 **저장**을 누르지 않는다.
   관리형 게시가 꺼져 있으면 **폼 저장이 곧 게시**다. 버튼은 사람이 누른다.

   ⚠ **콘솔만으로는 절반이다.** OTA(`expo-updates`)가 스토어 빌드 위에 JS 를 덮고, 그 축은
   콘솔에 안 보인다 — "지금 사용자가 무슨 코드를 도나"는 그 문서 **§2-1(스토어) + §2-4(OTA)** 를
   함께 봐야 답이 된다. OTA 쪽은 브라우저가 아니라 `eas update:list` / `eas channel:view` 이고,
   **각 앱 세션이 자기 것을 조회하는 게 정확하다** — 모르면 묻는다(2026-09-02: §2-1 만 보고
   "my_word 가 OTA 를 안 했다"고 단정했는데 3시간 전에 이미 나가 있었다).

   🔴 **문서와 달라진 앱이 있으면 그 세션에 알린다.** 갱신만 하고 넘어가면 그 세션은 계속 대기 상태로 있는다 —
   그게 이 작업의 목적이다(2026-09-02: 세 앱이 전부 문서보다 앞서 있었고 두 세션이 헛대기 중이었다).

2. **일의 성격에 따라 (해당하면 반드시)**:
   - **다른 앱 세션에 뭔가 알릴 일이면** → `docs/MULTI_SESSION.md`. **§5(오늘 틀린 것들)가 이 문서의 본체**다.
     🔴 `SDK_VERSION`을 올렸으면 **네 세션에 알리는 것까지가 일**이다 — 안 보내면 앱은 모른 채로 구버전을 배포한다.
   - **새 앱을 붙이거나 앱 쪽 계약을 건드리면** → `docs/ONBOARDING.md`(순서 · §8 증상→원인 표 ·
     §112 활성 하트비트 · §9 세션 간에 넘길 것).
   - **my_word 관련이면** → `docs/HANDOFF_MYWORD.md`.
   - **Next.js API를 쓰면** → `node_modules/next/dist/docs/`. 이 버전은 **훈련 데이터와 다르다**
     (CLAUDE.md 하단 경고). 기억으로 쓰지 말고 해당 가이드를 읽는다.

> **"전부 다 읽어"면** → 1 · 1.5 + `docs/` 전체(5개뿐이라 부담이 없다).
> 특정 작업을 이어가는 중이면 → 1 · 1.7 + 그 작업 영역 문서만으로 충분.

## 문서 먼저, 그다음 코드 (착수 전 항상)

0. **기존·상충 결정부터 읽는다 (가장 자주 빼먹는 단계)** — 계획을 적기 **전에**
   `CLAUDE.md 규약` + `docs/PLAN.md`에서 그 주제에 이미 내려진 결정을 `grep`으로 확인한다.
   특히 되살리기 쉬운 **제외/확정 결정**:
   - **Expand-only** — 기존 컬럼·응답 필드를 바꾸거나 지우지 않는다. `replied`/`resolved`는 앱에
     나가는 값이라 **개명하지 않는다**(추가는 하되).
   - **allowlist는 `apps` 테이블**(env 아님) — 앱 추가에 재배포 불필요.
   - **미등록·비활성 앱은 404**(400을 주면 존재를 탐지당한다).
   - **레이트리밋은 fail-open**이라 방어선이 아니다 — 무인증 write의 실질 방어는 **DB 일일 캡**.
   - **상태는 운영자가 정하는 값**이지 입력의 부수효과가 아니다.
   - **관리자 write에 `appCode` 스코프 필수**(1배포 N앱).
1. **결정을 문서에 먼저 적는다** — 새 결정은 `docs/PLAN.md`(또는 `CLAUDE.md 규약`)에 반영한다.
   기존 결정을 뒤집으면 **취소선/정정 주석으로 보존**한다(왜 바꿨는지가 다음 사람에게 필요하다).
2. **그다음 코드.** 3. **끝나면 `docs/NEXT.md`를 갱신한다** — 끝난 줄은 지우거나 PLAN으로 옮긴다(남겨두면 썩는다).

## 구현마다 검증 — 완료 선언 전

```bash
npm run typecheck                                            # 커밋 전 필수
node tools/_dv_purchase.ts && node tools/_dv_activity.ts      # DB·서버 불필요한 순수 가드
BASE_URL=... node tools/_dv_public.ts                         # 공개 라우트
BASE_URL=... ADMIN_TOKEN=... node tools/_dv_admin.ts          # 관리자 fail-closed
BASE_URL=... node tools/_dv_auth.ts                           # 로그인·세션
BASE_URL=... node tools/_dv_sdk.ts                            # client/ 가 서버 계약과 맞는지
```

- **계약을 바꿨으면 가드도 같이 늘린다.** 가드가 안 늘면 그 변경은 다음 리팩터에 조용히 되돌아간다.
- **배포**: `node tools/_vercel_env.ts && npx vercel --prod --yes`. env를 바꿨으면 **재배포해야 적용**된다.
- 🔴 **로컬 dev가 프로덕션 DB를 쓴다.** 파괴적 실험(대량 삽입·삭제)은 로컬 Postgres를 따로 띄운다.
  가드가 만드는 문의는 본문에 `[_dv_public]` 접두사가 붙는 게 유일한 구분 표식이다.
- 🔴 **시크릿 값은 대화·로그·커밋에 남기지 않는다.** 발급은 사람이 하고, 나는 **env 이름과 주입 위치만** 정한다.

## 끝나면

- 무엇을 다시 읽었는지 **한 줄로** 보고하고 중단됐던 작업을 이어간다(요약 재설명 생략).
- 읽은 내용 중 **현재 작업과 충돌하는 결정**이 있으면 먼저 짚는다(추정으로 덮어쓰지 않는다).
- **상태 요약("남은 것"·"다음 할 일"·앱별 표)을 쓸 때 자가 점검**: 각 줄이 **방금 읽은 파일/방금 부른 API**에서
  나왔나, **세션 초반 기억**에서 나왔나? 후자면 §1.7 표대로 근거를 열어 대조한 뒤 쓴다.
  특히 **"현재 DAU"·"이미 배포됨"·"그 앱은 SDK 몇 버전"·"아직 심사 중"** 이 네 가지가 가장 잘 상한다.
  마지막 것은 §1.8로 확인한다 — **"심사 중"은 세션이 가장 오래 붙들고 있는 낡은 사실**이다.

## 자동 트리거 (훅)

`.claude/settings.local.json`의 `SessionStart`(matcher `compact`) 훅이 컴팩트 완료 후
"reload-docs 스킬을 실행하라"는 안내를 컨텍스트에 주입한다 → 그걸 보면 이 스킬을 호출한다.
훅을 끄려면 그 항목을 지우면 되고, 이 스킬은 수동(`/reload-docs`)으로도 언제든 실행 가능하다.
