// 디스코드 알림 — 신규 문의를 채널로 통지.
//
// 원칙: **웹훅 URL 미설정이면 완전 no-op**(dev·미연결 무해). **절대 throw 없음**.
//   호출은 라우트에서 afterSafe(() => notifyTicket(...))로 **응답 후** 실행(응답 지연 0 · 서버리스 freeze 유실 방지).
//   웹훅 URL은 시크릿이므로 **DB에 저장하지 않는다** — 관리자 콘솔에 노출되면 곤란하므로 env 규약으로만 둔다.
//   채널: DISCORD_TICKET_WEBHOOK_URL_<APP_CODE 대문자> → 없으면 DISCORD_TICKET_WEBHOOK_URL → 없으면 no-op.

/** 공통 전송 — url 없으면 no-op, 실패는 삼킴, 4초 타임아웃. */
async function postDiscord(url: string, username: string, embed: Record<string, unknown>): Promise<void> {
  if (!url) return;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000); // 디스코드 지연에도 함수 안 물리게
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, embeds: [embed] }),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(t));
  } catch {
    /* 알림 실패는 무시 — 요청/응답 흐름과 완전 분리 */
  }
}

/** 앱 전용 문의 채널. env 키는 app_code를 대문자·비영숫자 치환으로 만든다(myword → ..._MYWORD). */
export function ticketWebhookUrl(appCode: string): string {
  const key = `DISCORD_TICKET_WEBHOOK_URL_${appCode.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  return process.env[key] || process.env.DISCORD_TICKET_WEBHOOK_URL || '';
}

const CAT_KO: Record<string, string> = {
  bug: '🐞 버그',
  suggestion: '💡 건의',
  question: '❓ 질문',
  etc: '🗂 기타',
};

export interface TicketNotice {
  ticketId: string;
  appCode: string;
  appName: string;
  category: string;
  content: string; // 사용자 작성 본문(표시하되 길이 컷)
  platform?: string | null;
  appVersion?: string | null;
}

/** 신규 문의 1건 통지. no-op·throw-none. */
export async function notifyTicket(n: TicketNotice): Promise<void> {
  const body = (n.content ?? '').slice(0, 1000); // Discord 필드 상한(1024) 안에서 컷
  await postDiscord(ticketWebhookUrl(n.appCode), `${n.appName} 문의`, {
    title: '📨 새 문의',
    color: 0x3498db,
    fields: [
      { name: '분류', value: CAT_KO[n.category] ?? n.category, inline: true },
      { name: '앱', value: n.appCode, inline: true },
      { name: '기기', value: `${n.platform ?? '—'}${n.appVersion ? ` · v${n.appVersion}` : ''}`, inline: true },
      { name: '내용', value: body || '—', inline: false },
    ],
    // 익명 접수라 표시할 유저가 없다 — ticketId만 남겨 관리자 콘솔에서 찾아갈 수 있게 한다.
    footer: { text: `ticket ${n.ticketId}` },
    timestamp: new Date().toISOString(),
  });
}
