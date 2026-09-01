// /api/admin/subjects/activity?app=<appCode>&id=<subjectId> — 한 사용자의 활동 달력("잔디").
//
// 목록(`/api/admin/subjects`)이 "지금 어떤 사람들이 있나"라면 여기는 **"이 사람이 언제 왔나"**다.
// 원천은 `subject_active_day` 하나 — 날짜 행이 있으면 그날 활성이었고, `hours`가 몇 시에 있었나다.
//
// ⚠ **앱 스코프는 필수다.** 1배포 N앱이라 subject id만으로 조회하면 콘솔이 A앱을 보는 중에
//   B앱 사용자의 접속 이력이 열린다. 읽기에도 쓰기와 같은 기준을 건다(CLAUDE.md 규약).
import { NextResponse } from 'next/server';
import { and, eq, gte } from 'drizzle-orm';
import { db } from '../../../../../db';
import { subjectActiveDay, subjects } from '../../../../../db/schema';
import { isAdmin } from '../../../../../lib/admin';
import { normalizeAppCode } from '../../../../../lib/apps';
import { HEAT_WEEKS, hourCount, kstYmd, windowDayKeys } from '../../../../../lib/activity';
import { reportError } from '../../../../../lib/observability';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const deny = () => NextResponse.json({ ok: false, reason: 'unauthorized' }, { status: 401 });
const bad = () => NextResponse.json({ ok: false, reason: 'bad-request' }, { status: 400 });

export async function GET(req: Request) {
  if (!isAdmin(req)) return deny();
  try {
    const q = new URL(req.url).searchParams;
    const appCode = normalizeAppCode(q.get('app'));
    const id = (q.get('id') ?? '').trim();
    if (!appCode || !UUID_RE.test(id)) return bad();

    const keys = windowDayKeys(HEAT_WEEKS * 7);
    const from = keys[0];

    const [subject] = await db
      .select({
        id: subjects.id,
        kind: subjects.kind,
        provider: subjects.provider,
        email: subjects.email,
        createdAt: subjects.createdAt,
        lastSeenAt: subjects.lastSeenAt,
        deletedAt: subjects.deletedAt,
      })
      .from(subjects)
      // 앱까지 맞아야 한다 — id만 맞으면 타앱 사용자가 열린다
      .where(and(eq(subjects.id, id), eq(subjects.appCode, appCode)))
      .limit(1);
    if (!subject) return NextResponse.json({ ok: false, reason: 'not-found' }, { status: 404 });

    const rows = await db
      .select({ day: subjectActiveDay.day, hours: subjectActiveDay.hours })
      .from(subjectActiveDay)
      .where(
        and(
          eq(subjectActiveDay.appCode, appCode),
          eq(subjectActiveDay.subjectId, id),
          gte(subjectActiveDay.day, from),
        ),
      );

    return NextResponse.json({
      ok: true,
      subject,
      // 창 전체 날짜를 함께 준다 — 화면이 날짜 계산을 다시 하지 않게(경계가 두 곳에 있으면 어긋난다).
      from,
      to: keys[keys.length - 1],
      // 행이 **있는 날만** 내려간다. 없는 날 = 그날 활성 아님.
      // hours 0 = 활성이었으나 시각 미수집(2026-09-01 이전 행) — 화면이 그렇게 구분해 칠한다.
      days: rows.map((r) => ({ day: String(r.day).slice(0, 10), h: hourCount(r.hours) })),
      // 이 앱이 활성 일자를 모으기 시작한 날. 그 이전 칸은 "활동 없음"이 아니라 **"모으기 전"**이다.
      collectingFrom: (
        await db
          .select({ first: subjectActiveDay.day })
          .from(subjectActiveDay)
          .where(eq(subjectActiveDay.appCode, appCode))
          .orderBy(subjectActiveDay.day)
          .limit(1)
      )[0]?.first ?? null,
      today: kstYmd(),
    });
  } catch (e) {
    reportError(e, 'admin/subjects/activity:GET');
    return NextResponse.json({ ok: false, reason: 'error' }, { status: 500 });
  }
}
