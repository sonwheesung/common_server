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

export type App = typeof apps.$inferSelect;
export type AppSettings = typeof appSettings.$inferSelect;
export type Announcement = typeof announcements.$inferSelect;
export type Ticket = typeof tickets.$inferSelect;
export type Subject = typeof subjects.$inferSelect;
export type AppAuthProvider = typeof appAuthProviders.$inferSelect;
