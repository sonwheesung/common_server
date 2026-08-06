// GET /api/v1/bootstrap?app=<appCode> — 앱 부팅 시 단 1회 조회: 점검 · 버전게이트 · 활성 공지.
//
// 앱 로컬 신뢰 금지: 진입 게이트(강제 업데이트·점검)는 **이 응답으로만** 결정한다.
// 스토어 심사에 묶이지 않고 DB로 앱 진입을 막을 수 있는 게 이 라우트의 존재 이유다.
import { NextResponse } from 'next/server';
import { and, desc, eq, gte, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '../../../../db';
import { announcements, appSettings } from '../../../../db/schema';
import { getActiveApp } from '../../../../lib/apps';
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

    return NextResponse.json({
      ok: true,
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
