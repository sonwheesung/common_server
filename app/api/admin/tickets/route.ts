// /api/admin/tickets?app=<appCode>&status=<status> — 문의 열람·처리.
//
// v1의 reply는 **관리자 내부 메모**다. 익명 단방향 접수라 사용자에게 답변을 되돌려줄 경로가 없다
// (subject 모델이 들어오면 그때 열린다 — docs/PLAN.md §8). 콘솔에도 그렇게 표시한다.
import { NextResponse } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../../../db';
import { tickets } from '../../../../db/schema';
import { isAdmin } from '../../../../lib/admin';
import { normalizeAppCode } from '../../../../lib/apps';
import { reportError } from '../../../../lib/observability';

export const dynamic = 'force-dynamic';

const STATUSES = new Set(['open', 'replied', 'resolved']);
const LIST_LIMIT = 200;

const deny = () => NextResponse.json({ ok: false, reason: 'unauthorized' }, { status: 401 });
const bad = (reason = 'bad-request') => NextResponse.json({ ok: false, reason }, { status: 400 });

export async function GET(req: Request) {
  if (!isAdmin(req)) return deny();
  try {
    const q = new URL(req.url).searchParams;
    const appCode = normalizeAppCode(q.get('app'));
    if (!appCode) return bad();
    const status = q.get('status');

    const where =
      status && STATUSES.has(status)
        ? and(eq(tickets.appCode, appCode), eq(tickets.status, status))
        : eq(tickets.appCode, appCode);

    const rows = await db.select().from(tickets).where(where).orderBy(desc(tickets.createdAt)).limit(LIST_LIMIT);
    return NextResponse.json({ ok: true, tickets: rows });
  } catch (e) {
    reportError(e, 'admin/tickets:GET');
    return NextResponse.json({ ok: false, reason: 'error' }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  if (!isAdmin(req)) return deny();
  try {
    const b = (await req.json()) as { id?: string; status?: string; reply?: string };
    const id = String(b.id ?? '');
    if (!id) return bad();

    const patch: Record<string, unknown> = {};
    if (typeof b.status === 'string' && STATUSES.has(b.status)) patch.status = b.status;
    if (typeof b.reply === 'string') {
      patch.reply = b.reply.trim().slice(0, 4000) || null;
      patch.repliedAt = patch.reply ? new Date() : null;
      // 메모를 남기면 상태를 명시하지 않아도 replied로 올린다(목록에서 처리분이 바로 갈리게).
      if (!patch.status && patch.reply) patch.status = 'replied';
    }
    if (!Object.keys(patch).length) return bad('nothing-to-update');

    const updated = await db.update(tickets).set(patch).where(eq(tickets.id, id)).returning();
    if (!updated.length) return NextResponse.json({ ok: false, reason: 'not-found' }, { status: 404 });
    return NextResponse.json({ ok: true, ticket: updated[0] });
  } catch (e) {
    reportError(e, 'admin/tickets:PATCH');
    return NextResponse.json({ ok: false, reason: 'error' }, { status: 500 });
  }
}
