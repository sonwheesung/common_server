// Drizzle 스키마 — 공통 서버 v1(공지사항·문의하기). docs/PLAN.md §4.
//
// 멀티앱 격리: 모든 테이블이 `app_code` FK를 갖는다. 배구 서버(`proj_code`)와 같은 방식이지만,
// 이쪽은 코드가 **env로 고정되지 않고 요청 파라미터**로 온다(1배포 N앱). 그래서 allowlist가 곧 `apps` 테이블이다.
//
// v1은 신원(subject)을 두지 않는다 — 공지는 읽기 전용 브로드캐스트, 문의는 단방향 익명이라 필요가 없다.
// 쿠폰·광고제거를 붙일 때 `subjects` 테이블을 추가하고 tickets에 `subject_id`(nullable)를 **덧붙인다**(Expand-only, PLAN §8).
import { pgTable, uuid, text, integer, boolean, timestamp, index, uniqueIndex, primaryKey } from 'drizzle-orm/pg-core';

// ── 앱 레지스트리 ── 공개 라우트 allowlist의 근거. 배구는 env(ANON_TICKET_PROJECTS)였으나 여기선 DB로 둔다
//    — 앱을 하나 늘릴 때마다 재배포하지 않기 위해서.
export const apps = pgTable('apps', {
  appCode: text('app_code').primaryKey(), // 'myword' 등. 앱 번들에 박히는 식별자(시크릿 아님)
  name: text('name').notNull(),
  active: boolean('active').notNull().default(true), // false면 공개 라우트가 404(존재 노출 안 함)
  ticketDailyCap: integer('ticket_daily_cap').notNull().default(30), // 24h 문의 총량 캡(익명 라우트 실질 방어선)
  // ── RevenueCat 웹훅 ──
  // env가 아니라 DB인 이유는 위와 같다(앱 추가에 재배포 불필요). 다만 이건 **진짜 시크릿**이라
  // 원문을 두지 않고 sha256만 둔다 — 이 DB가 읽히는 사고(Supabase Data API 오설정 등)가
  // "문의 본문 유출"에서 "엔타이틀먼트 위조 가능"으로 등급이 오르지 않게.
  // sha256은 KDF가 아니므로 **고엔트로피 값만 받는다**(콘솔이 32바이트를 생성해준다).
  rcWebhookSecretHash: text('rc_webhook_secret_hash'), // null = 그 앱 웹훅 전면 거부(fail-closed)
  // 허용 엔타이틀먼트 키(콤마 구분). RC 대시보드의 오타가 유령 키를 만들지 않게 하는 **필터**다.
  // 상품→키 매핑이 아니다 — 매핑을 우리가 들면 RC의 attach 누락이 우리 매핑에 가려진다.
  entitlementKeys: text('entitlement_keys').notNull().default('pro'),
  /**
   * 콘솔 앱 선택 목록의 **표시 순서**. 작을수록 위. 2026-09-02.
   *
   * 종전엔 등록일 순이었다 — 그건 "언제 붙였나"이지 **"얼마나 자주 보나"가 아니다.**
   * 앱이 늘수록 자주 보는 앱이 아래로 밀리고, 그건 순서를 바꿀 수단이 없어서 생기는 불편이다.
   *
   * ⚠ 기본값 0으로 시작하므로 **처음엔 전부 동률**이고, 그때는 이름순으로 떨어진다(2차 정렬).
   * 등록일을 2차로 두지 않은 이유: 동률일 때 순서가 **눈에 보이는 값으로 설명돼야** 하기 때문이다.
   * 이름은 화면에 있고 등록일은 없다 — 안 보이는 값으로 정렬하면 "왜 이 순서지"에 답할 수 없다.
   */
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── 앱별 부팅 설정(1행) ── 앱이 부팅 시 조회: 버전 게이트 + 서버 점검.
// 스토어 강제업데이트에 의존하지 않고 **DB로 우회**한다 — minVersion 미만이면 진입 차단, maintenance면 점검 화면.
export const appSettings = pgTable('app_settings', {
  appCode: text('app_code')
    .primaryKey()
    .references(() => apps.appCode),
  minVersion: text('min_version'), // 이 미만 = 강제 업데이트(진입 차단). null=게이트 없음
  latestVersion: text('latest_version'), // 이 미만 = 소프트 업데이트 안내. null=없음
  androidStoreUrl: text('android_store_url'),
  iosStoreUrl: text('ios_store_url'),
  maintenance: boolean('maintenance').notNull().default(false),
  maintenanceTitle: text('maintenance_title'),
  maintenanceBody: text('maintenance_body'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── 공지사항 ── 기간(startsAt~endsAt) 동안만 노출. 부팅 시 bootstrap이 활성분만 반환.
// 읽음 여부는 **앱 로컬**에서 관리한다(서버에 읽음 테이블을 두지 않는다 — 비회원 앱엔 매달 대상이 없고,
// 있어도 공지 하나에 유저 수만큼 행이 생겨 이득 대비 비용이 크다).
export const announcements = pgTable(
  'announcements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appCode: text('app_code')
      .notNull()
      .references(() => apps.appCode),
    kind: text('kind').notNull().default('notice'), // notice | event | update (앱·admin에서 검증, DB는 text)
    title: text('title').notNull(),
    body: text('body').notNull(), // 마크다운 원문
    pinned: boolean('pinned').notNull().default(false),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull().defaultNow(),
    endsAt: timestamp('ends_at', { withTimezone: true }), // null = 무기한
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ann_app_starts_idx').on(t.appCode, t.startsAt)],
);

// ── 문의(티켓) ── 익명 단방향 접수. 누가 보냈는지는 **서버도 모른다**(개인정보 최소수집).
// 저장하는 기기정보는 platform·appVersion 뿐 — "어떤 환경에서 난 문제인가"에 필요한 최소치.
// osVersion·IP는 저장하지 않는다(익명 문의에서 기기 지문 최소화, 배구 /api/ticket/anon과 같은 판단).
// reply는 v1에선 관리자 내부 메모 성격 — 사용자가 답변을 볼 경로는 subject 모델 도입 후 열린다(PLAN §8).
export const tickets = pgTable(
  'tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appCode: text('app_code')
      .notNull()
      .references(() => apps.appCode),
    // 작성자 — **nullable**이 핵심이다(Expand-only). 익명 접수는 계속 null로 들어오고,
    // 로그인 앱에서만 채워진다. 기존 익명 문의를 건드리지 않고 회원 문의를 얹기 위한 설계.
    // 이 값이 있어야 "내 문의 내역"과 답변 회신이 가능하다.
    subjectId: uuid('subject_id').references(() => subjects.id),
    category: text('category').notNull(), // bug | suggestion | question | etc
    content: text('content').notNull(), // ≤2000자(라우트에서 컷)
    status: text('status').notNull().default('open'), // open | replied | resolved
    reply: text('reply'),
    repliedAt: timestamp('replied_at', { withTimezone: true }),
    platform: text('platform'), // ios | android | web
    appVersion: text('app_version'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('tickets_app_created_idx').on(t.appCode, t.createdAt), // 목록 조회 + 24h 캡 카운트
    index('tickets_app_status_idx').on(t.appCode, t.status),
    index('tickets_subject_idx').on(t.subjectId, t.createdAt), // "내 문의 내역" 조회
  ],
);

// ── 주체(subject) ── 로그인 사용자·익명 기기를 한 테이블로 다룬다.
// 문의·(향후)쿠폰·엔타이틀먼트가 전부 subject_id 하나에만 매달리게 해서 회원/비회원 코드 경로가 갈라지지 않게 한다.
//
// provider가 **enum이 아니라 text인 이유**: 카카오·애플이 뒤에 온다. text면 공급자 추가가 마이그레이션이 아니라
// 데이터가 된다(검증기만 붙이면 됨). 실제 허용 여부는 검증기가 구현된 공급자인지로 결정한다(fail-closed).
//
// UNIQUE(app_code, provider, provider_id) — **앱별 계정 격리**. 같은 구글 계정이라도 앱이 다르면 별개 사용자다
// (앱마다 별개 서비스이므로 A앱 문의가 B앱에서 보이면 안 된다).
export const subjects = pgTable(
  'subjects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appCode: text('app_code')
      .notNull()
      .references(() => apps.appCode),
    kind: text('kind').notNull().default('user'), // user | device(향후 비회원 앱)
    provider: text('provider').notNull(), // google | kakao | apple | device
    providerId: text('provider_id').notNull(), // 구글 sub 등 공급자 고유 식별자
    // 구글 ID토큰에서 검증된 이메일(운영 식별용). 공급자가 안 줄 수도 있어 nullable.
    // 개인정보이므로 탈퇴 시 지운다(파기).
    email: text('email'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    // 탈퇴 소프트삭제. 지울 때 provider_id를 가명화(tombstone)해 **재로그인으로 부활하지 않게** 한다.
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    // RevenueCat pull 쿨다운 스탬프(lib/rcPull.ts). 조건부 UPDATE의 대상이라 **쿨다운이자 락**이다.
    // Redis가 아니라 여기 있는 이유: 이 저장소의 Upstash는 미설정이고 리미터는 fail-open이라,
    // 거기 얹으면 "미설정 = 쿨다운 없음"이 되어 인프라가 흔들릴 때 RC 호출이 터진다.
    rcPulledAt: timestamp('rc_pulled_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('subjects_app_provider_uniq').on(t.appCode, t.provider, t.providerId),
    index('subjects_app_idx').on(t.appCode),
  ],
);

// ── 앱별 소셜 로그인 설정 ── 공급자별 audience(클라이언트 ID) 목록.
// env가 아니라 DB에 두는 이유는 `apps`와 같다 — 앱을 늘릴 때마다 재배포하지 않기 위해서다.
// 클라이언트 ID는 앱 번들에 박히는 **공개값**이라 DB 보관이 안전하다(시크릿이 아니다).
// 구글은 android/ios/web 3개를 쓰므로 콤마 구분 목록으로 둔다. 카카오(REST 키)·애플(bundle id)도 같은 모양.
export const appAuthProviders = pgTable(
  'app_auth_providers',
  {
    appCode: text('app_code')
      .notNull()
      .references(() => apps.appCode),
    provider: text('provider').notNull(),
    audiences: text('audiences').notNull(), // 콤마 구분. 비어 있으면 검증 불가 → 로그인 거부(fail-closed)
    enabled: boolean('enabled').notNull().default(true),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.appCode, t.provider] })],
);

// ── 엔타이틀먼트(구독·광고제거) ── RevenueCat 웹훅이 진실을 밀어넣는다. PLAN §8 Phase 9.
//
// **`active`를 저장하지 않는다.** 저장하면 순서역전 방어가 "이벤트 시각 비교"라는 로직 하나에 전부 걸리고,
// 그게 틀리면 조용히 틀린다. 대신 만료시각을 두고 읽을 때 계산한다:
//
//   active = expiresAt > now
//            AND (graceUntil은 별도로 살림)
//            AND NOT (revokedTxnId = lastTxnId)
//
// 갱신 계열(INITIAL·RENEWAL·UNCANCELLATION)은 expiresAt을 **max()로만** 움직인다 → 교환법칙이 성립해
// 도착 순서와 무관하게 같은 상태로 수렴한다(배구의 가법 원장이 순서역전에 안전했던 것과 같은 성질).
// 반면 PRODUCT_CHANGE·EXPIRATION은 만료를 **앞당길 수 있어** max()로 못 다룬다 → 덮어쓰되 lastEventAt으로 막는다.
// 시각 비교가 필요한 곳을 그 둘로 좁힌 것이 이 설계의 요점이다.
export const entitlements = pgTable(
  'entitlements',
  {
    appCode: text('app_code')
      .notNull()
      .references(() => apps.appCode),
    subjectId: uuid('subject_id')
      .notNull()
      .references(() => subjects.id),
    // RC의 entitlement_ids를 그대로 쓴다. 상품→키 매핑을 우리가 또 들면 RC의 attach 누락을
    // 우리 매핑이 가려버린다(누락은 "빈 배열"로 드러나야 한다). apps.entitlementKeys는 필터일 뿐이다.
    key: text('key').notNull(), // 'pro'
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    // 결제 실패 유예. 여기서 바로 끊으면 카드 갱신 중인 사람의 백업이 멈춘다.
    graceUntil: timestamp('grace_until', { withTimezone: true }),
    willRenew: boolean('will_renew').notNull().default(true), // CANCELLATION = 해지 예약일 뿐 아직 활성
    // 회수를 **거래에 묶는다**. 영구 플래그로 두면 "한 기간분만 환불되고 구독은 살아있는" 경우
    // 이후 갱신이 와도 영원히 비활성이 된다("돈은 내는데 pro가 아닌" 상태 — 제일 나쁜 실패 모드).
    // 거래 id로 비교하면 다음 갱신(새 txn)에서 자동으로 풀린다.
    lastTxnId: text('last_txn_id'),
    revokedTxnId: text('revoked_txn_id'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }), // 표시·감사용(판정은 revokedTxnId로 한다)
    productId: text('product_id'),
    environment: text('environment').notNull().default('PRODUCTION'), // PRODUCTION | SANDBOX
    // PRODUCT_CHANGE·EXPIRATION의 순서 가드. 갱신 계열은 max()라 이 값을 안 본다.
    lastEventAt: timestamp('last_event_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.subjectId, t.key] }),
    index('ent_app_key_idx').on(t.appCode, t.key),
  ],
);

// ── 결제 이벤트 감사 로그(append-only) ── 멱등과 감사를 한 테이블로 겸한다.
// rcEventId UNIQUE가 곧 멱등키다 — RC는 웹훅을 재전송하므로 이게 없으면 같은 갱신이 만료를 두 번 민다.
//
// 판정 결과(outcome)를 함께 남긴다. "무시했다"도 기록이어야 한다 — 안 남기면 결제가 안 붙었을 때
// 웹훅이 안 온 건지 와서 무시된 건지 구분할 방법이 없다.
export const purchaseEvents = pgTable(
  'purchase_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appCode: text('app_code').notNull(),
    rcEventId: text('rc_event_id').notNull(),
    type: text('type').notNull(), // INITIAL_PURCHASE | RENEWAL | ...
    appUserId: text('app_user_id'), // RC가 보낸 원문(비-UUID여도 기록은 남긴다)
    subjectId: uuid('subject_id'), // 해석 성공 시에만. FK를 걸지 않는다 — 미해석 이벤트도 남겨야 한다
    productId: text('product_id'),
    entitlementKey: text('entitlement_key'),
    storeTxnId: text('store_txn_id'),
    environment: text('environment'),
    outcome: text('outcome').notNull(), // applied | deduped | ignored | rejected
    reason: text('reason'), // ignored/rejected 사유(anonymous · unknown-subject · sandbox · stale · unknown-key ...)
    eventAt: timestamp('event_at', { withTimezone: true }),
    // **이 이벤트가 만들어낸 만료 시각.** 2026-08-19 실결제 검증에서 "만료가 왜 이 값이 됐나"를
    // 사후에 가르지 못했다(원문은 raw에 있었지만 조회·표시가 안 됐다). 판정 결과를 1급 필드로 남긴다.
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    raw: text('raw'), // 원문 JSON(잘라서). 사후 재구성이 가능해야 한다
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('purchase_events_rc_event_uniq').on(t.rcEventId),
    index('purchase_events_app_created_idx').on(t.appCode, t.createdAt),
    index('purchase_events_subject_idx').on(t.subjectId),
  ],
);

// ── 활성 일자 ── DAU/WAU/MAU와 요일 추이의 원천. 2026-09-01.
//
// **왜 `subjects.lastSeenAt`으로는 안 되는가**: 그 컬럼은 주체당 **한 칸**이라 덮어써진다.
// 매일 켠 사람도 "오늘" 버킷에만 잡히므로 과거로 갈수록 체계적으로 과소 집계된다 —
// 날짜 축은 최신 쪽으로 단조 편향되기 때문에 왜곡이 조용하고 크다(배구 서버가 요일 차트에서 겪은 함정).
// 그래서 "언제 마지막에 봤나"(lastSeenAt)와 "어느 날에 활성이었나"(이 테이블)를 **다른 사실로** 나눠 둔다.
//
// day는 timestamp가 아니라 **KST로 접은 'YYYY-MM-DD' 문자열**이다. 어느 시간대로 하루를 자를지는
// 운영 판단이므로 DB(UTC)에 맡기지 않고 코드(lib/activity.ts)에 명시한다.
//
// PK가 곧 멱등키다 — 하루에 몇 번을 켜도 1행. 그래서 하트비트가 몇 군데에 있어도 중복 계상되지 않는다.
// 개인정보는 없다(주체 id + 날짜뿐. IP·기기지문 없음). 보관기간은 lib/retention.ts.
export const subjectActiveDay = pgTable(
  'subject_active_day',
  {
    appCode: text('app_code')
      .notNull()
      .references(() => apps.appCode),
    subjectId: uuid('subject_id')
      .notNull()
      .references(() => subjects.id),
    day: text('day').notNull(), // KST 'YYYY-MM-DD'
    // 그날 **몇 시에** 활성이었나 — KST 0~23시를 비트 24개로 접는다(비트 i = i시).
    //
    // 왜 `lastSeenAt`으로 안 되나: 그건 주체당 한 칸이라 **마지막 접속 시각**만 남는다.
    // 그걸로 시간 분포를 그리면 "몇 시에 사람이 많나"가 아니라 "몇 시에 마지막으로 껐나"가 된다
    // (배구 콘솔이 그 한계를 '마지막 접속 시각'이라고 이름에 적어두고 쓰는 것과 같은 사정).
    //
    // 왜 시각 행을 따로 안 쌓나: 그러면 하루에 주체당 최대 24행이 생긴다. 비트마스크는
    // **행 수를 하루 1행으로 고정**하면서 같은 질문에 답한다 — OR이라 멱등이고 순서도 무관하다.
    hours: integer('hours').notNull().default(0),

    /**
     * 이 행이 **웜 스타트 하트비트**(`POST /v1/heartbeat`)로도 찍혔나. 2026-09-02 (Phase 13).
     *
     * **왜 필요한가**: 앱이 `AppState` 리스너를 붙이는 날 그 앱의 DAU가 뛴다. 사용자가 는 게 아니라
     * **세는 방법이 바뀐 것**인데, 화면에는 똑같이 "DAU 증가"로 보인다. 그 경계를 표시하지 않으면
     * 다음 사람이 "9월 초에 성장했다"로 읽는다 — Phase 12가 막아둔 거짓말 셋과 같은 종류다.
     *
     * ⚠ **수동 필드로 두지 않았다.** `apps.heartbeatSince` 같은 칸을 만들면 앱이 실제로 붙인 날과
     * 운영자가 적은 날이 어긋나고, **어긋난 줄 아무도 모른다**(적는 걸 잊으면 영영 빈칸이다).
     * 이건 데이터에서 파생된다 — 앱이 붙이면 다음 복귀에 자동으로 켜지고, 떼면 자동으로 멈춘다.
     *
     * OR로 얹으므로 멱등이다(`hours`와 같은 이유). 콜드 스타트만 있는 날은 false로 남고,
     * 그게 곧 "그날은 웜 스타트를 못 셌다"는 기록이 된다.
     */
    warm: boolean('warm').notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.appCode, t.subjectId, t.day] }),
    index('subject_active_day_app_day_idx').on(t.appCode, t.day), // 일별 집계 스캔
  ],
);

export type App = typeof apps.$inferSelect;
export type AppSettings = typeof appSettings.$inferSelect;
export type Announcement = typeof announcements.$inferSelect;
export type Ticket = typeof tickets.$inferSelect;
export type Subject = typeof subjects.$inferSelect;
export type AppAuthProvider = typeof appAuthProviders.$inferSelect;
export type Entitlement = typeof entitlements.$inferSelect;
export type PurchaseEvent = typeof purchaseEvents.$inferSelect;
export type SubjectActiveDay = typeof subjectActiveDay.$inferSelect;
