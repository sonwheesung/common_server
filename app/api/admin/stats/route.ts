// /api/admin/stats?app=<appCode> — 대시보드 지표 · 운영 알림 · 웹훅 오류 집계 · 인프라 배선 상태.
//
// **알림 판정은 서버에서 한다.** 화면이 판정하면 임계가 UI 코드에 흩어지고, 화면을 안 열면 아무도 모른다.
// 여기 한 곳에 두면 나중에 크론이 같은 함수를 불러 디스코드로 밀 수 있다.
//
// 인프라 배선(`infra`)을 함께 내려주는 이유: 디스코드 웹훅·RC pull 키가 없으면 **조용히 no-op**이라
// 안 붙은 줄 모른다(CLAUDE.md의 경고). 값은 절대 내려보내지 않고 **붙었는지 여부만** 준다.
import { NextResponse } from 'next/server';
import { and, count, desc, eq, gte, inArray, isNull } from 'drizzle-orm';
import { db } from '../../../../db';
import { apps, appSettings, purchaseEvents, subjects, tickets } from '../../../../db/schema';
import { isAdmin } from '../../../../lib/admin';
import { normalizeAppCode } from '../../../../lib/apps';
import { activeCount } from '../../../../lib/entitlement';
import { activitySummary } from '../../../../lib/activity';
import { ticketWebhookUrl } from '../../../../lib/notify';
import { rcSecretKey } from '../../../../lib/rcPull';
import { sentryEnabled } from '../../../../lib/sentryGate';
import { reportError } from '../../../../lib/observability';

export const dynamic = 'force-dynamic';

const ACTIVE_DAYS = 14;
/** "지금 쓰고 있는 사람" 창(분). 30분 — 세션 하나를 넉넉히 덮으면서 어제 사람이 섞이지 않는 길이. */
const ONLINE_WINDOW_MIN = 30;
const STALE_WARN_H = 48; // 미처리 문의 방치 경고
const STALE_CRIT_H = 72;
const ERROR_LIMIT = 30;

type Severity = 'warn' | 'crit';
type Alert = { key: string; label: string; detail: string; severity: Severity; tab?: string };

const deny = () => NextResponse.json({ ok: false, reason: 'unauthorized' }, { status: 401 });
const bad = (reason = 'bad-request') => NextResponse.json({ ok: false, reason }, { status: 400 });

/** 미처리 = 대기 + 확인 중. "확인 중"을 처리됨으로 세면 조사하다 만 문의가 목록에서 사라진다. */
const PENDING = ['open', 'reviewing'];

/** 이 라우트가 매번 판정하는 항목. 알림이 0건일 때 화면이 "무엇이 정상인지"를 말할 수 있게 함께 내려보낸다.
 *  아래 판정문을 늘리면 **여기도 같이 늘린다** — 어긋나면 화면이 안 본 것을 봤다고 말하게 된다. */
const ALERT_CHECKS = [
  '앱 활성',
  '점검 모드',
  '문의 방치',
  '문의 일일 캡',
  '웹훅 거부',
  'RC 웹훅 시크릿',
  '문의 알림 채널',
  '활성 계측',
  '웜 스타트 계측',
];

export async function GET(req: Request) {
  if (!isAdmin(req)) return deny();
  try {
    const appCode = normalizeAppCode(new URL(req.url).searchParams.get('app'));
    if (!appCode) return bad();

    const app = (await db.select().from(apps).where(eq(apps.appCode, appCode)).limit(1))[0];
    if (!app) return NextResponse.json({ ok: false, reason: 'not-found' }, { status: 404 });

    const now = Date.now();
    const day = new Date(now - 86400_000);
    const activeCutoff = new Date(now - ACTIVE_DAYS * 86400_000);
    const onlineCutoff = new Date(now - ONLINE_WINDOW_MIN * 60_000);

    const [subjTotal, subjActive, subjOnline, subjNew, subjKinds, tkTotal, tkPending, tk24, oldest, subs, byReason, recent, errToday, setting, activity] =
      await Promise.all([
        db.select({ n: count() }).from(subjects).where(eq(subjects.appCode, appCode)),
        db
          .select({ n: count() })
          .from(subjects)
          .where(and(eq(subjects.appCode, appCode), isNull(subjects.deletedAt), gte(subjects.lastSeenAt, activeCutoff))),
        // "지금 쓰고 있는 사람" — lastSeenAt이 매 부팅 갱신되므로 이 창이 의미를 갖는다.
        // DAU와 다른 것을 잰다: DAU는 오늘 하루 누구든, 이건 지금 이 순간.
        db
          .select({ n: count() })
          .from(subjects)
          .where(and(eq(subjects.appCode, appCode), isNull(subjects.deletedAt), gte(subjects.lastSeenAt, onlineCutoff))),
        db.select({ n: count() }).from(subjects).where(and(eq(subjects.appCode, appCode), gte(subjects.createdAt, day))),
        // 주체 종류별 분해 — **`사용자` 수를 앱끼리 비교해도 되는가**를 화면이 판정할 수 있게 한다.
        // 로그인 앱이 비로그인 DAU를 위해 기기 subject를 **따로** 두면, 로그인한 사람은 device 1행 +
        // user 1행으로 **영구히 2행**이 된다(병합 개념이 없다). 그런 앱의 누적 사용자 수는 부풀어
        // 있으므로 다른 앱과 나란히 놓으면 그 앱만 과대평가된다.
        // ⚠ 앱 코드를 하드코딩하지 않는다 — **구조에서 판정**한다. 같은 모양의 앱이 나중에 또 생기면
        //   그때도 자동으로 잡히고, 조각이 구조를 바꾸면 경고가 저절로 사라진다.
        db
          .select({ kind: subjects.kind, n: count() })
          .from(subjects)
          .where(eq(subjects.appCode, appCode))
          .groupBy(subjects.kind),
        db.select({ n: count() }).from(tickets).where(eq(tickets.appCode, appCode)),
        db
          .select({ n: count() })
          .from(tickets)
          .where(and(eq(tickets.appCode, appCode), inArray(tickets.status, PENDING))),
        db.select({ n: count() }).from(tickets).where(and(eq(tickets.appCode, appCode), gte(tickets.createdAt, day))),
        // 가장 오래 방치된 미처리 문의 1건 — "몇 건인가"보다 "얼마나 오래 뒀나"가 먼저 읽혀야 한다.
        db
          .select({ createdAt: tickets.createdAt })
          .from(tickets)
          .where(and(eq(tickets.appCode, appCode), inArray(tickets.status, PENDING)))
          .orderBy(tickets.createdAt)
          .limit(1),
        activeCount(appCode),
        // 무시·거부 사유별 집계. "결제가 안 붙었다"가 웹훅 미수신인지 수신 후 거부인지 여기서 갈린다.
        db
          .select({ outcome: purchaseEvents.outcome, reason: purchaseEvents.reason, n: count() })
          .from(purchaseEvents)
          .where(and(eq(purchaseEvents.appCode, appCode), inArray(purchaseEvents.outcome, ['rejected', 'ignored'])))
          .groupBy(purchaseEvents.outcome, purchaseEvents.reason)
          .orderBy(desc(count())),
        db
          .select({
            id: purchaseEvents.id,
            type: purchaseEvents.type,
            outcome: purchaseEvents.outcome,
            reason: purchaseEvents.reason,
            productId: purchaseEvents.productId,
            entitlementKey: purchaseEvents.entitlementKey,
            environment: purchaseEvents.environment,
            createdAt: purchaseEvents.createdAt,
          })
          .from(purchaseEvents)
          .where(and(eq(purchaseEvents.appCode, appCode), inArray(purchaseEvents.outcome, ['rejected', 'ignored'])))
          .orderBy(desc(purchaseEvents.createdAt))
          .limit(ERROR_LIMIT),
        db
          .select({ n: count() })
          .from(purchaseEvents)
          .where(
            and(
              eq(purchaseEvents.appCode, appCode),
              eq(purchaseEvents.outcome, 'rejected'),
              gte(purchaseEvents.createdAt, day),
            ),
          ),
        db.select().from(appSettings).where(eq(appSettings.appCode, appCode)).limit(1),
        activitySummary(appCode, new Date(now)),
      ]);

    const one = (r: { n: number }[]) => r[0]?.n ?? 0;
    const pending = one(tkPending);
    const last24 = one(tk24);
    const cap = app.ticketDailyCap;
    const rejected24 = one(errToday);
    const oldestH = oldest[0] ? Math.floor((now - oldest[0].createdAt.getTime()) / 3600_000) : 0;

    const infra = {
      // 값이 아니라 **붙었는지만** — 시크릿을 화면으로 내보내지 않는다.
      discord: ticketWebhookUrl(appCode) !== '',
      rcPullKey: rcSecretKey(appCode) !== '',
      rcWebhook: app.rcWebhookSecretHash !== null,
      sentry: sentryEnabled(),
      ratelimit: Boolean(process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL),
    };

    // 미설정을 **어떻게 고치는지**까지 화면에 내려준다 — 이름만 내려가고 **값은 절대 안 나간다**.
    // env 이름 규칙은 lib/notify.ts · lib/rcPull.ts에 있고, 화면이 그걸 베꼈 쓰면 반드시 어깋난다.
    const UP = appCode.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const infraEnv = {
      discord: `DISCORD_TICKET_WEBHOOK_URL_${UP}`,
      rcPullKey: `RC_SECRET_API_KEY_${UP}`,
      rcWebhook: '', // env가 아니다 — 콘솔 구독 탭에서 생성한다(DB 보관)
      sentry: 'SENTRY_DSN',
      ratelimit: 'UPSTASH_REDIS_REST_URL · UPSTASH_REDIS_REST_TOKEN',
    };

    const alerts: Alert[] = [];
    if (!app.active) {
      alerts.push({
        key: 'app_inactive',
        label: '앱 비활성',
        detail: '공개 라우트가 전부 404를 반환합니다',
        severity: 'crit',
        tab: 'apps',
      });
    }
    if (setting[0]?.maintenance) {
      alerts.push({
        key: 'maintenance',
        label: '점검 모드 켜짐',
        detail: '모든 사용자의 진입이 차단됩니다',
        severity: 'crit',
        tab: 'settings',
      });
    }
    if (pending > 0 && oldestH >= STALE_WARN_H) {
      alerts.push({
        key: 'tickets_stale',
        label: '문의 방치',
        detail: `미처리 ${pending}건 · 가장 오래된 것이 ${Math.floor(oldestH / 24)}일 ${oldestH % 24}시간 경과`,
        severity: oldestH >= STALE_CRIT_H ? 'crit' : 'warn',
        tab: 'tickets',
      });
    }
    if (cap > 0 && last24 >= cap) {
      alerts.push({
        key: 'ticket_cap',
        label: '문의 일일 캡 도달',
        detail: `24시간 ${last24}건 / 캡 ${cap} — 신규 접수가 429로 막힙니다`,
        severity: 'crit',
        tab: 'settings',
      });
    } else if (cap > 0 && last24 >= cap * 0.7) {
      alerts.push({
        key: 'ticket_cap_near',
        label: '문의 캡 근접',
        detail: `24시간 ${last24}건 / 캡 ${cap}`,
        severity: 'warn',
        tab: 'settings',
      });
    }
    if (rejected24 > 0) {
      alerts.push({
        key: 'webhook_rejected',
        label: '웹훅 거부 발생',
        detail: `최근 24시간 ${rejected24}건 거부 — 그만큼 결제가 권한에 반영되지 않았습니다`,
        severity: rejected24 >= 5 ? 'crit' : 'warn',
        tab: 'errors',
      });
    }
    if (!infra.rcWebhook) {
      alerts.push({
        key: 'webhook_unconfigured',
        label: 'RC 웹훅 시크릿 미설정',
        detail: '이 앱의 웹훅이 전부 401로 거부됩니다(fail-closed)',
        severity: 'warn',
        tab: 'billing',
      });
    }
    // 계측이 아직 안 붙은 앞 — 주체는 있는데 활성 기록이 한 행도 없다.
    // "DAU 0"을 **진짜 0**으로 읽히게 두면 안 된다 — 앱이 하트비트를 실은 SDK로
    // 재배포되기 전까지는 원래 0이다(조용한 no-op을 화면에 드러낸다는 규약).
    if (one(subjTotal) > 0 && activity.coverageDays === 0) {
      alerts.push({
        key: 'activity_uncollected',
        label: '활성 계측 미수집',
        detail: `주체 ${one(subjTotal)}명이 있지만 활성 기록이 0행 — 앱이 SDK ${'2026-09-01'} 이상으로 재배포도었는지 확인하세요`,
        severity: 'warn',
        tab: 'overview',
      });
    }

    // 🔴 **웜 스타트 계측이 안 붙었다.** 앱이 SDK는 복사했는데 `AppState` 리스너를 안 붙이면
    // 서버에서는 그 둘이 **구분되지 않는다** — 콜드 스타트 하트비트는 그대로 오기 때문이다.
    // 이 알림이 그 차이를 드러내는 유일한 신호다("복사했다"와 "동작한다"는 다르다).
    //
    // ⚠ 활성 기록이 아예 없는 앱에는 안 띄운다 — 그건 위의 `activity_uncollected`가 말한다.
    //   두 알림이 같은 앱에 동시에 뜨면 "무엇부터 고칠지"가 흐려진다.
    if (activity.coverageDays > 0 && activity.warmSince === null) {
      alerts.push({
        key: 'warm_uncollected',
        label: '웜 스타트 계측 미부착',
        detail:
          'DAU가 과소집계되고 있습니다 — 앱을 켠 뒤 안 죽이는 사용자는 다음 날부터 안 잡힙니다. ' +
          '앱이 SDK 2026-09-02 이상으로 재배포되고 AppState 리스너를 붙여야 합니다.',
        severity: 'warn',
      });
    }
    if (!infra.discord) {
      alerts.push({
        key: 'notify_off',
        label: '문의 알림 채널 없음',
        detail: `DISCORD_TICKET_WEBHOOK_URL_${appCode.toUpperCase()} 미설정 — 콘솔을 직접 열기 전엔 문의가 온 줄 모릅니다`,
        severity: 'warn',
        tab: 'settings',
      });
    }

    return NextResponse.json({
      ok: true,
      kpi: {
        subjects: one(subjTotal),
        /**
         * 주체 종류별 분해 + **앱끼리 비교해도 되는가**.
         *
         * `device`와 `user`가 **둘 다** 있으면 그 앱은 로그인 사용자에게 subject를 2행 만든다
         * (비로그인 DAU용 기기 subject를 따로 두는 구조). 병합 개념이 없으므로 그 2행은 영구적이고,
         * 그래서 **누적 사용자 수가 그 앱만 부풀어 있다** — 다른 앱과 나란히 놓으면 과대평가된다.
         * 화면이 그걸 말하지 않으면 다음 사람이 "조각이 제일 크다"로 읽는다.
         *
         * ⚠ 앱 코드가 아니라 **데이터 모양**으로 판정한다. 같은 구조의 앱이 또 생기면 자동으로 잡히고,
         *   그 앱이 구조를 바꾸면 경고가 저절로 사라진다.
         * ⚠ DAU는 이 왜곡을 **거의 안 받는다** — 하루에 한 종류만 찍히고, 로그인 전환일에만 2행이다
         *   (사용자당 평생 1회). 부풀어 있는 건 **누적 수**다.
         */
        subjectKinds: Object.fromEntries(subjKinds.map((r) => [r.kind, r.n])) as Record<string, number>,
        subjectsDualCounted: subjKinds.filter((r) => r.n > 0).length > 1,
        // ⚠ lastSeenAt 기반. 2026-09-01 이전엔 이 컬럼이 등록 시점에만 갱신돼
        //   사실상 "최근 14일 신규 설치"였다. 하트비트가 붙은 뒤에야 제 뜻을 갖는다 —
        //   사람이 보는 활성 지표는 아래 `activity`를 쓴다.
        subjectsActive: one(subjActive),
        subjectsOnline: one(subjOnline),
        onlineWindowMin: ONLINE_WINDOW_MIN,
        subjectsNew24h: one(subjNew),
        subscribers: subs,
        tickets: one(tkTotal),
        ticketsPending: pending,
        tickets24h: last24,
        ticketCap: cap,
        oldestPendingHours: oldestH,
        activeDays: ACTIVE_DAYS,
      },
      alerts,
      // 알림이 빈 것이 "정상"인지 "판정을 안 했음"인지 화면이 구분할 수 있게,
      // **무엇을 봤는지**를 함께 내려보낸다. 상수가 아니라 위 판정문과 같은 곳에 둔다.
      alertChecks: ALERT_CHECKS,
      infra,
      infraEnv,
      activity,
      errors: { byReason, recent, rejected24h: rejected24 },
    });
  } catch (e) {
    reportError(e, 'admin/stats:GET');
    return NextResponse.json({ ok: false, reason: 'error' }, { status: 500 });
  }
}
