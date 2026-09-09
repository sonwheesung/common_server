// 디스코드 알림 — 신규 문의 · 구독 변화를 채널로 통지.
//
// 원칙: **웹훅 URL 미설정이면 완전 no-op**(dev·미연결 무해). **절대 throw 없음**.
//   호출은 라우트에서 afterSafe(() => notifyTicket(...))로 **응답 후** 실행(응답 지연 0 · 서버리스 freeze 유실 방지).
//   웹훅 URL은 시크릿이므로 **DB에 저장하지 않는다** — 관리자 콘솔에 노출되면 곤란하므로 env 규약으로만 둔다.
//   채널: DISCORD_TICKET_WEBHOOK_URL_<APP_CODE 대문자> → 없으면 DISCORD_TICKET_WEBHOOK_URL → 없으면 no-op.
//
// 🔴 **구독 알림은 문의와 같은 채널을 쓴다**(2026-09-09 사용자 결정 — *"채널을 따로 안 받아도 돼"*).
//   근거는 알림량이다: 지금 이 서버로 오는 알림이 테스트·구글 테스터 것 말고는 거의 없다.
//   → 나눠야 할 때가 오면 `subscriptionWebhookUrl()`만 갈아끼우면 된다. 호출부는 안 바뀐다.
//   ⚠ env 이름이 `..._TICKET_...`인 채로 구독도 실어 보낸다는 뜻이다 — 이름과 쓰임이 어긋나 있고,
//     그건 **의도된 것**이다. 채널을 나누는 날 이 주석과 함수를 같이 고친다.

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

// ─────────────────────────── 구독 알림 ───────────────────────────

/** 구독 알림 채널. 지금은 문의와 같다 — 위 주석의 결정을 한 곳에 가둬 둔다. */
export function subscriptionWebhookUrl(appCode: string): string {
  return ticketWebhookUrl(appCode);
}

/**
 * 알릴 이벤트는 **셋뿐**이다(2026-09-09 사용자 결정 — *"구독 시작, 해지 시점"*).
 *
 * 🔴 사용자가 말한 "해지"는 RC에서 **두 시점으로 갈린다.** 둘 다 보낸다 —
 *   `CANCELLATION`만 보내면 **취소를 안 누르고 결제 실패로 조용히 끝나는 경우를 놓치고**,
 *   `EXPIRATION`만 보내면 해지 의사를 며칠~한 달 늦게 안다.
 *   ⚠ 대신 한 구독이 알림을 두 번 낸다. 문구를 달리 해 "아직 쓸 수 있음"과 "권한 사라짐"을 가른다.
 *
 * ✅ `REFUND` 추가(2026-09-09 같은 날 결정) — **돈이 실제로 되돌아가는 사건**이라 모르고 지나가면 아깝다.
 *   해지와 달리 사용자가 스토어·고객센터를 통해 일으키므로 **앱에서는 아무 흔적도 안 남는다.**
 *
 * 🚫 뺀 것: `RENEWAL`(갱신) · `BILLING_ISSUE`(결제 실패 유예) · `PRODUCT_CHANGE` · `PULL`.
 *   `PULL`은 우리가 스스로 당긴 동기화라 알림이 아니고, 나머지는 사용자가 요청하지 않았다.
 *   ⚠ `BILLING_ISSUE`는 **결제가 실패해 유예에 들어간 상태**다 — 여기서 안 알리면 그 사용자는
 *     `EXPIRATION`이 올 때 처음 보이고, 그땐 이미 떠난 뒤다. 붙이려면 여기 한 줄이다.
 */
const NOTIFY_TYPES = new Set(['INITIAL_PURCHASE', 'CANCELLATION', 'EXPIRATION', 'REFUND']);

export const shouldNotifySubscription = (type: string): boolean => NOTIFY_TYPES.has((type ?? '').toUpperCase());

/** KST 표시. 사장님이 읽는 화면이라 UTC로 찍지 않는다(어긋나면 "9시간 전 일"로 오독한다). */
function kstText(d: Date | null | undefined): string {
  if (!d || Number.isNaN(d.getTime())) return '—';
  const k = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${k.getUTCFullYear()}-${p(k.getUTCMonth() + 1)}-${p(k.getUTCDate())} ${p(k.getUTCHours())}:${p(k.getUTCMinutes())} KST`;
}

export interface SubscriptionNotice {
  type: string; // INITIAL_PURCHASE | CANCELLATION | EXPIRATION
  appCode: string;
  appName: string;
  productId?: string | null;
  entitlementKey?: string | null;
  /** NORMAL | TRIAL | INTRO — 체험 시작과 실결제를 가르는 유일한 축이다. */
  periodType?: string | null;
  price?: number | null;
  currency?: string | null;
  expiresAt?: Date | null;
  cancelReason?: string | null;
  environment?: string | null;
}

/** 구독 변화 1건 통지. no-op·throw-none. **호출 전에 `shouldNotifySubscription`으로 거른다.** */
export async function notifySubscription(n: SubscriptionNotice): Promise<void> {
  const type = (n.type ?? '').toUpperCase();
  const trial = (n.periodType ?? '').toUpperCase() === 'TRIAL';

  // 제목·색은 "사장님이 무엇을 해야 하나"로 가른다 — 시작은 초록, 아직 살아 있는 해지는 노랑, 종료는 빨강.
  let title: string;
  let color: number;
  let note: string;
  if (type === 'INITIAL_PURCHASE') {
    title = trial ? '🎉 구독 시작 — 무료체험' : '🎉 구독 시작 — 결제';
    color = 0x2ecc71;
    // 🔴 체험은 결제가 아니다. 여기서 안 가르면 첫 유료 전환이 언제인지 영영 모른다.
    note = trial
      ? `무료체험입니다(결제액 0원). **${kstText(n.expiresAt)}** 에 첫 결제가 일어납니다.`
      : '실제 결제입니다.';
  } else if (type === 'CANCELLATION') {
    title = '⚠️ 해지 예약';
    color = 0xf1c40f;
    // 아직 활성이다 — "구독자 수가 줄었다"로 읽으면 안 된다.
    note = `자동갱신이 꺼졌습니다. **${kstText(n.expiresAt)}** 까지는 그대로 사용합니다.`;
  } else if (type === 'REFUND') {
    title = '💸 환불';
    color = 0x9b59b6;
    // 🔴 해지와 다르다: 돈이 되돌아갔고 권한도 **즉시** 회수된다. 앱에는 아무 흔적이 안 남는다.
    //   ⚠ "다음 결제분은 살아 있을 수 있다" — 한 기간분만 환불되면 다음 갱신에서 자동으로 다시 켜진다.
    note = '돈이 되돌아갔고 권한을 **즉시 회수**했습니다. 한 기간분만 환불된 경우라면 다음 결제에서 자동으로 다시 켜집니다.';
  } else {
    title = '⛔ 구독 종료';
    color = 0xe74c3c;
    note = '권한이 사라졌습니다. 해지 예약 없이 이 알림만 왔다면 **결제 실패로 끝난 것**입니다.';
  }

  const money =
    typeof n.price === 'number' ? `${n.price.toLocaleString('ko-KR')} ${n.currency ?? ''}`.trim() : '—';

  const fields: Record<string, unknown>[] = [
    { name: '앱', value: n.appName || n.appCode, inline: true },
    { name: '상품', value: n.productId ?? '—', inline: true },
    { name: '금액', value: trial ? `${money} (체험)` : money, inline: true },
  ];
  if (type !== 'EXPIRATION') fields.push({ name: '다음 시점', value: kstText(n.expiresAt), inline: true });
  if (n.cancelReason) fields.push({ name: '사유', value: String(n.cancelReason), inline: true });
  // 🔴 SANDBOX는 애초에 알림까지 오지 않지만(라우트가 applied만 통지), 왔다면 화면에 드러낸다.
  if ((n.environment ?? '').toUpperCase() === 'SANDBOX') fields.push({ name: '환경', value: '🧪 SANDBOX', inline: true });
  fields.push({ name: '', value: note, inline: false });

  await postDiscord(subscriptionWebhookUrl(n.appCode), `${n.appName} 구독`, {
    title,
    color,
    fields,
    footer: { text: `${n.appCode} · ${n.entitlementKey ?? '—'}` },
    timestamp: new Date().toISOString(),
  });
}
