// /api/admin/announcements?app=<appCode> — 공지 발행·수정·삭제.
// 공개 bootstrap과 달리 **기간 필터를 걸지 않는다**(예정·종료분도 보여야 관리가 된다).
import { NextResponse } from 'next/server';
import { desc, eq } from 'drizzle-orm';
import { db } from '../../../../db';
import { announcements } from '../../../../db/schema';
import { isAdmin } from '../../../../lib/admin';
import { normalizeAppCode } from '../../../../lib/apps';
import { reportError } from '../../../../lib/observability';

export const dynamic = 'force-dynamic';

const KINDS = new Set(['notice', 'event', 'update']);
const LIST_LIMIT = 200;

const deny = () => NextResponse.json({ ok: false, reason: 'unauthorized' }, { status: 401 });
const bad = (reason = 'bad-request') => NextResponse.json({ ok: false, reason }, { status: 400 });

/** ISO 문자열 → Date. 빈 값·파싱 실패는 null(무기한/기본값 의미). */
function parseDate(v: unknown): Date | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function GET(req: Request) {
  if (!isAdmin(req)) return deny();
  try {
    const appCode = normalizeAppCode(new URL(req.url).searchParams.get('app'));
    if (!appCode) return bad();
    const rows = await db
      .select()
      .from(announcements)
      .where(eq(announcements.appCode, appCode))
      .orderBy(desc(announcements.startsAt))
      .limit(LIST_LIMIT);
    return NextResponse.json({ ok: true, announcements: rows });
  } catch (e) {
    reportError(e, 'admin/announcements:GET');
    return NextResponse.json({ ok: false, reason: 'error' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  if (!isAdmin(req)) return deny();
  try {
    const b = (await req.json()) as Record<string, unknown>;
    const appCode = normalizeAppCode(b.appCode);
    const title = String(b.title ?? '').trim();
    const body = String(b.body ?? '').trim();
    if (!appCode || !title || !body) return bad();

    const startsAt = parseDate(b.startsAt);
    const endsAt = parseDate(b.endsAt);
    // 종료가 시작보다 앞서면 아무에게도 안 보이는 공지가 조용히 생긴다 — 발행 시점에 막는다.
    if (startsAt && endsAt && endsAt.getTime() <= startsAt.getTime()) return bad('ends-before-starts');

    const ins = await db
      .insert(announcements)
      .values({
        appCode,
        kind: KINDS.has(String(b.kind)) ? String(b.kind) : 'notice',
        title: title.slice(0, 200),
        body: body.slice(0, 10000),
        pinned: Boolean(b.pinned),
        ...(startsAt ? { startsAt } : {}), // 미지정이면 DB defaultNow() — JS 클럭 스큐 회피
        endsAt,
      })
      .returning();

    return NextResponse.json({ ok: true, announcement: ins[0] });
  } catch (e) {
    reportError(e, 'admin/announcements:POST');
    return NextResponse.json({ ok: false, reason: 'error' }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  if (!isAdmin(req)) return deny();
  try {
    const b = (await req.json()) as Record<string, unknown>;
    const id = String(b.id ?? '');
    if (!id) return bad();

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (typeof b.title === 'string' && b.title.trim()) patch.title = b.title.trim().slice(0, 200);
    if (typeof b.body === 'string' && b.body.trim()) patch.body = b.body.trim().slice(0, 10000);
    if (typeof b.kind === 'string' && KINDS.has(b.kind)) patch.kind = b.kind;
    if (typeof b.pinned === 'boolean') patch.pinned = b.pinned;
    if ('startsAt' in b) {
      const d = parseDate(b.startsAt);
      if (d) patch.startsAt = d;
    }
    if ('endsAt' in b) patch.endsAt = parseDate(b.endsAt); // null = 무기한으로 되돌리기

    const updated = await db.update(announcements).set(patch).where(eq(announcements.id, id)).returning();
    if (!updated.length) return NextResponse.json({ ok: false, reason: 'not-found' }, { status: 404 });
    return NextResponse.json({ ok: true, announcement: updated[0] });
  } catch (e) {
    reportError(e, 'admin/announcements:PATCH');
    return NextResponse.json({ ok: false, reason: 'error' }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  if (!isAdmin(req)) return deny();
  try {
    const id = new URL(req.url).searchParams.get('id') ?? '';
    if (!id) return bad();
    const del = await db.delete(announcements).where(eq(announcements.id, id)).returning({ id: announcements.id });
    if (!del.length) return NextResponse.json({ ok: false, reason: 'not-found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    reportError(e, 'admin/announcements:DELETE');
    return NextResponse.json({ ok: false, reason: 'error' }, { status: 500 });
  }
}
