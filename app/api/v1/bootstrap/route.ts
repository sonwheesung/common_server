// GET /api/v1/bootstrap?app=<appCode> — 앱 부팅 시 단 1회 조회: 점검 · 버전게이트 · 활성 공지.
//
// 앱 로컬 신뢰 금지: 진입 게이트(강제 업데이트·점검)는 **이 응답으로만** 결정한다.
// 스토어 심사에 묶이지 않고 DB로 앱 진입을 막을 수 있는 게 이 라우트의 존재 이유다.
//
// **활성 하트비트를 겸한다**(2026-09-01). 매 실행마다 불리는 유일한 라우트라서 여기가 DAU의 관측점이다.
import { NextResponse } from 'next/server';
import { and, desc, eq, gte, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '../../../../db';
import { announcements, appSettings, subjects } from '../../../../db/schema';
import { getActiveApp } from '../../../../lib/apps';
import { sessionFromRequest, shouldRenew, signSession } from '../../../../lib/auth/session';
import { recordActive } from '../../../../lib/activity';
import { afterSafe } from '../../../../lib/afterSafe';
import { checkLimit, clientIp } from '../../../../lib/ratelimit';
import { reportError } from '../../../../lib/observability';

export const dynamic = 'force-dynamic';

const ANN_LIMIT = 50; // 부팅 페이로드 방어 — 관리자 목록 페이지네이션과는 별개

export async function GET(req: Request) {
  if (!(await checkLimit('bootstrap', clientIp(req))).ok) {
    return NextResponse.json({ ok: false, reason: 'rate-limited' }, { status: 429 });
  }

  try {
    const app = await getActiveApp(new URL(req.url).searchParams.get('app'));
    // 미등록/비활성 — 존재를 노출하지 않도록 404
    if (!app) return NextResponse.json({ ok: false, reason: 'not-found' }, { status: 404 });

    const [settingsRows, anns] = await Promise.all([
      db.select().from(appSettings).where(eq(appSettings.appCode, app.appCode)).limit(1),
      db
        .select()
        .from(announcements)
        .where(
          and(
            eq(announcements.appCode, app.appCode),
            // 기간 판정은 **DB now()** 기준 — 서버 인스턴스 클럭 스큐를 타지 않게(발행측도 DB defaultNow()를 쓴다)
            lte(announcements.startsAt, sql`now()`),
            or(isNull(announcements.endsAt), gte(announcements.endsAt, sql`now()`)),
          ),
        )
        .orderBy(desc(announcements.pinned), desc(announcements.startsAt))
        .limit(ANN_LIMIT),
    ]);

    const s = settingsRows[0];

    // ── 활성 하트비트 ──
    // 토큰은 **선택**이다. 다른 라우트와 달리 헤더가 무효여도 401로 막지 않고 조용히 건너뛴다 —
    // 여기는 진입 게이트라, 세션이 만료됐다는 이유로 점검·강제업데이트 판정을 못 받으면 안 된다.
    // 토큰의 app과 조회 대상 app이 **둘 다** 맞아야 한다(A앱 토큰으로 B앱 DAU를 부풀리지 못하게).
    // 응답 후 처리 — 관측이 부팅을 1ms도 늦추지 않는다.
    const claims = sessionFromRequest(req);
    // 재발급된 토큰. 응답에 실리면 SDK가 조용히 교체한다(앱 호출부는 모른다).
    let session: { token: string } | undefined;
    if (claims && claims.app === app.appCode) {
      afterSafe(() => recordActive(app.appCode, claims.sid));

      // ── 슬라이딩 갱신 ──
      // 발급 경로가 로그인·기기등록 둘뿐이라 종전엔 iat+180일이 **고정 카운트다운**이었다.
      // 앱을 매일 써도 그날이 오면 토큰이 죽고, 여긴 무효 토큰을 401 없이 조용히 무시하므로
      // 그 사용자는 DAU에서 영구히 사라졌다 — 앱도 서버도 모르는 채로.
      if (shouldRenew(claims.iat)) {
        // 갱신은 30일에 1회뿐이라 여기서만 DB를 한 번 더 본다 —
        // 탈퇴한 주체의 세션을 연장해주지 않기 위해서다(권한은 requireSubject가 따로 막지만,
        // 죽은 세션을 연장하는 것 자체가 틀렸다).
        const alive = (
          await db
            .select({ id: subjects.id })
            .from(subjects)
            .where(and(eq(subjects.id, claims.sid), isNull(subjects.deletedAt)))
            .limit(1)
        )[0];
        if (alive) {
          const next = signSession({ sid: claims.sid, app: claims.app });
          if (next) session = { token: next };
        }
      }
    }

    return NextResponse.json({
      ok: true,
      // 있을 때만 실린다. 앱 화면은 이 필드를 볼 일이 없고 SDK가 삼킨다.
      ...(session ? { session } : {}),
      maintenance: s?.maintenance
        ? { active: true, title: s.maintenanceTitle ?? '서버 점검 중', body: s.maintenanceBody ?? '' }
        : { active: false },
      version: {
        min: s?.minVersion ?? null, // 이 미만 = 강제 업데이트(진입 차단)
        latest: s?.latestVersion ?? null, // 이 미만 = 소프트 안내
        androidUrl: s?.androidStoreUrl ?? null,
        iosUrl: s?.iosStoreUrl ?? null,
      },
      // startsAt = 유저에게 게시된 시점 → 앱의 공지 목록에서 "등록일"로 표시한다.
      announcements: anns.map((a) => ({
        id: a.id,
        kind: a.kind,
        title: a.title,
        body: a.body,
        pinned: a.pinned,
        startsAt: a.startsAt,
      })),
    });
  } catch (e) {
    reportError(e, 'v1/bootstrap');
    return NextResponse.json({ ok: false, reason: 'error' }, { status: 500 });
  }
}
