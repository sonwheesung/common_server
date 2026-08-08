// GET /api/v1/tickets/mine — 내가 보낸 문의와 답변.
//
// 이게 로그인의 **존재 이유**다. 익명 문의는 답변을 돌려줄 경로가 없어서 단방향이지만,
// 주체가 있으면 답변을 여기서 확인할 수 있다.
//
// 관리자 콘솔의 `reply`가 곧 사용자에게 보이는 답변이 된다 — 익명 시절의 "내부 메모"와 성격이 달라진다.
// 콘솔에서 그 차이를 표시해야 운영자가 내부 메모를 쓰듯 답변을 쓰는 사고를 피할 수 있다.
import { NextResponse } from 'next/server';
import { desc, eq } from 'drizzle-orm';
import { db } from '../../../../../db';
import { tickets } from '../../../../../db/schema';
import { requireSubject } from '../../../../../lib/auth/subject';
import { reportError } from '../../../../../lib/observability';

export const dynamic = 'force-dynamic';

const LIMIT = 50;

export async function GET(req: Request) {
  try {
    const authed = await requireSubject(req);
    if (!authed) return NextResponse.json({ ok: false, reason: 'unauthorized' }, { status: 401 });

    const rows = await db
      .select({
        id: tickets.id,
        category: tickets.category,
        content: tickets.content,
        status: tickets.status,
        reply: tickets.reply,
        createdAt: tickets.createdAt,
        repliedAt: tickets.repliedAt,
      })
      .from(tickets)
      // subject_id로만 조회한다 — app으로 한 번 더 거를 필요가 없다.
      // 주체 자체가 앱에 묶여 있고(UNIQUE app+provider+id), requireSubject가 토큰의 app과 대조했다.
      .where(eq(tickets.subjectId, authed.subject.id))
      .orderBy(desc(tickets.createdAt))
      .limit(LIMIT);

    return NextResponse.json({ ok: true, tickets: rows });
  } catch (e) {
    reportError(e, 'v1/tickets/mine');
    return NextResponse.json({ ok: false, reason: 'error' }, { status: 500 });
  }
}
