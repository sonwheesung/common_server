// Drizzle 스키마 — 공통 서버 v1(공지사항·문의하기). docs/PLAN.md §4.
//
// 멀티앱 격리: 모든 테이블이 `app_code` FK를 갖는다. 배구 서버(`proj_code`)와 같은 방식이지만,
// 이쪽은 코드가 **env로 고정되지 않고 요청 파라미터**로 온다(1배포 N앱). 그래서 allowlist가 곧 `apps` 테이블이다.
//
// v1은 신원(subject)을 두지 않는다 — 공지는 읽기 전용 브로드캐스트, 문의는 단방향 익명이라 필요가 없다.
// 쿠폰·광고제거를 붙일 때 `subjects` 테이블을 추가하고 tickets에 `subject_id`(nullable)를 **덧붙인다**(Expand-only, PLAN §8).
import { pgTable, uuid, text, integer, boolean, timestamp, index } from 'drizzle-orm/pg-core';

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
  ],
);

export type App = typeof apps.$inferSelect;
export type AppSettings = typeof appSettings.$inferSelect;
export type Announcement = typeof announcements.$inferSelect;
export type Ticket = typeof tickets.$inferSelect;
