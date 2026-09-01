'use client';

// 관리자 콘솔 — 좌측 사이드바 IA(배구 서버 ops 콘솔 참고).
//
// ⚠ 경로의 무작위 문자열은 **보안 장치가 아니다**. 실제 방어는 서버의 ADMIN_TOKEN fail-closed 검증이고,
//   경로는 크롤링·우연한 방문을 줄이는 부수 조치일 뿐이다.
// 토큰은 **서버에서 통한 뒤에만** 저장하고, localStorage에 30일 슬라이딩으로 둔다(↓ TOKEN_KEY 주석).
//
// 배구 콘솔과 다른 점: 저쪽은 PROJ_CODE 고정이라 앱 개념이 없지만 여기는 **1배포 N앱**이다.
// 그래서 앱 선택이 사이드바 최상단 일급 요소이고, URL에도 앱이 들어간다(?app=&tab=).
//
// 데이터는 **루트에서 한 번에** 불러 탭들에 내려준다. 탭마다 따로 부르면 미처리 문의 뱃지도
// 대시보드 요약도 만들 수 없다(각 탭이 자기 데이터만 알기 때문).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  Boxes,
  Check,
  ChevronLeft,
  Clock,
  CreditCard,
  Download,
  Inbox,
  KeyRound,
  LayoutDashboard,
  Loader2,
  Lock,
  LogOut,
  Megaphone,
  Menu,
  MessageSquare,
  Moon,
  OctagonAlert,
  Pin,
  Plus,
  RefreshCw,
  Server,
  Settings2,
  ShieldCheck,
  Sun,
  Trash2,
  Users,
  Wrench,
  X,
} from 'lucide-react';

type App = { appCode: string; name: string; active: boolean; ticketDailyCap: number };
type Settings = {
  appCode: string;
  minVersion: string | null;
  latestVersion: string | null;
  androidStoreUrl: string | null;
  iosStoreUrl: string | null;
  maintenance: boolean;
  maintenanceTitle: string | null;
  maintenanceBody: string | null;
};
type Announcement = {
  id: string;
  kind: string;
  title: string;
  body: string;
  pinned: boolean;
  startsAt: string;
  endsAt: string | null;
};
type Ticket = {
  id: string;
  /** 로그인 사용자의 문의면 채워진다. null = 익명 접수(답변을 돌려줄 경로가 없다) */
  subjectId: string | null;
  subjectEmail: string | null;
  subjectDeleted: string | null;
  category: string;
  content: string;
  status: string;
  reply: string | null;
  repliedAt: string | null;
  platform: string | null;
  appVersion: string | null;
  createdAt: string;
};

type AuthProvider = { appCode: string; provider: string; audiences: string; enabled: boolean };

type SubjectRow = {
  id: string;
  kind: string;
  provider: string;
  email: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  deletedAt: string | null;
  ticketCount: number;
  entitlement: { key: string; active: boolean; expiresAt: string | null } | null;
};

type Alert = { key: string; label: string; detail: string; severity: 'warn' | 'crit'; tab?: Tab };
type Stats = {
  kpi: {
    subjects: number;
    subjectsActive: number;
    subjectsNew24h: number;
    subscribers: number;
    tickets: number;
    ticketsPending: number;
    tickets24h: number;
    ticketCap: number;
    oldestPendingHours: number;
    activeDays: number;
  };
  alerts: Alert[];
  /** 시크릿 값이 아니라 **붙었는지 여부**만. 조용한 no-op을 화면에 드러내기 위한 것이다. */
  infra: { discord: boolean; rcPullKey: boolean; rcWebhook: boolean; sentry: boolean; ratelimit: boolean };
  /** 활성 지표 — subject_active_day 기반. `coverageDays === 0`이면 **수집 전**이다(진짜 0이 아니다). */
  activity: {
    dau: number;
    wau: number;
    mau: number;
    series: { day: string; n: number }[];
    weekday: { dow: number; label: string; avg: number | null; samples: number }[];
    coverageDays: number;
    chartReady: boolean;
    windowDays: number;
  };
  errors: {
    byReason: { outcome: string; reason: string | null; n: number }[];
    recent: {
      id: string;
      type: string;
      outcome: string;
      reason: string | null;
      productId: string | null;
      entitlementKey: string | null;
      environment: string | null;
      createdAt: string;
    }[];
    rejected24h: number;
  };
};

type Tab = 'overview' | 'anns' | 'tickets' | 'subjects' | 'billing' | 'errors' | 'settings' | 'apps';

// ── 브랜드(★ 다른 앱 이식 지점) ─────────────────────────────────────────────
// 앱 고유 문자열은 여기 한 객체에만 둔다. 종전엔 로그인 화면·사이드바·헤더 3곳에 흩어져 있어
// 이식할 때마다 grep 노동이 반복됐다. 이식 = BRAND 교체 + globals.css 토큰 교체 + NAV 교체.
const BRAND = { icon: Server, console: '관리자 콘솔', product: '공통 서버' };

// ── 관리자 토큰 보관 ──────────────────────────────────────────────────────────────
// 종전엔 sessionStorage였다 — 탭을 닫을 때마다 다시 붙여넣어야 했다(2026-09-01 사용자).
// 배구 콘솔은 localStorage에 **무기한**으로 둔다. 여긴 거기서 만료만 더한다 —
// 쓰는 동안에는 안 끊기고(열 때마다 연장), 방치한 노트북에선 결국 만료된다.
//
// ⚠ 대가는 분명하다: 토큰이 **디스크에 남고 브라우저 재시작을 견딘다.**
//   이 화면에 HTML 주입 싱크가 없어서(React가 전부 이스케이프, dangerouslySetInnerHTML 없음)
//   허용했을 뿐, 공용 PC에선 로그아웃을 누르는 게 아니라 **필수**다.
const TOKEN_KEY = 'cs_admin_token';
/** 슬라이딩 만료(일). 짧다고 느끼면 여기 한 줄만 고친다. */
const TOKEN_TTL_DAYS = 30;

/** 저장된 토큰 — 만료됐거나 깨졌으면 지우고 빈 문자열. */
function readToken(): string {
  try {
    // 구판(sessionStorage) 잔존값도 한 번은 받아준다 — 이번 탭에선 다시 안 물어보게.
    const legacy = sessionStorage.getItem(TOKEN_KEY);
    if (legacy) {
      sessionStorage.removeItem(TOKEN_KEY);
      saveToken(legacy);
      return legacy;
    }
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return '';
    const v = JSON.parse(raw) as { t?: string; exp?: number };
    if (!v.t || typeof v.exp !== 'number' || v.exp < Date.now()) {
      localStorage.removeItem(TOKEN_KEY);
      return '';
    }
    return v.t;
  } catch {
    return ''; // 저장소가 막혔거나(사생 모드) 값이 깨졌다 — 로그인 화면으로 보내면 된다
  }
}

/** 토큰 저장 + 만료 연장. **서버에서 통한 뒤에만** 부른다. */
function saveToken(t: string) {
  try {
    localStorage.setItem(TOKEN_KEY, JSON.stringify({ t, exp: Date.now() + TOKEN_TTL_DAYS * 86400_000 }));
  } catch {
    /* 저장 실패해도 이번 탭은 메모리 토큰으로 그대로 돌아간다 */
  }
}

function clearToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* 무시 */
  }
}
const CATEGORY_KO: Record<string, string> = { bug: '버그', suggestion: '건의', question: '질문', etc: '기타' };
const KIND_KO: Record<string, string> = { notice: '공지', event: '이벤트', update: '업데이트' };

// 상태 워크플로: 대기 → 확인 중 → 답변함 / 완료. **미처리 = 대기 + 확인 중**이다.
// '확인 중'을 처리됨으로 세면 조사하다 만 문의가 목록에서 사라진다.
const PENDING_STATUSES = ['open', 'reviewing'];
const isPending = (s: string) => PENDING_STATUSES.includes(s);
const STATUS_TONE: Record<string, 'muted' | 'accent' | 'ok' | 'warn' | 'danger'> = {
  open: 'warn',
  reviewing: 'accent',
  replied: 'ok',
  resolved: 'muted',
};
/** `replied`의 라벨은 작성자에 따라 다르다 — 회원이면 앱에 노출되는 '답변', 익명이면 '내부 메모'다. */
function statusLabel(status: string, hasSubject: boolean): string {
  if (status === 'open') return '대기';
  if (status === 'reviewing') return '확인 중';
  if (status === 'replied') return hasSubject ? '답변함' : '메모됨';
  if (status === 'resolved') return '완료';
  return status;
}
const STATUS_OPTIONS: [string, string][] = [
  ['open', '대기'],
  ['reviewing', '확인 중'],
  ['replied', '답변함 / 메모됨'],
  ['resolved', '완료'],
];

const NAV: { id: Tab; icon: React.ElementType; label: string; grp?: string }[] = [
  { id: 'overview', icon: LayoutDashboard, label: '대시보드' },
  { id: 'anns', icon: Megaphone, label: '공지', grp: '운영' },
  { id: 'tickets', icon: MessageSquare, label: '문의', grp: '운영' },
  { id: 'subjects', icon: Users, label: '사용자', grp: '운영' },
  { id: 'billing', icon: CreditCard, label: '구독', grp: '운영' },
  { id: 'errors', icon: OctagonAlert, label: '오류', grp: '운영' },
  { id: 'settings', icon: Wrench, label: '앱 설정', grp: '설정' },
  { id: 'apps', icon: Boxes, label: '앱 관리', grp: '설정' },
];
const TITLES: Record<Tab, string> = {
  overview: '대시보드',
  anns: '공지 관리',
  tickets: '문의',
  subjects: '사용자',
  billing: '구독',
  errors: '오류 · 웹훅 감사',
  settings: '앱 설정',
  apps: '앱 관리',
};

// 서버가 주는 reason 코드를 그대로 노출하면 운영자에게 `bad-request`·`Failed to fetch`가 뜬다.
// 코드 → 한국어 사유로 옮기고, 모르는 코드는 코드 그대로 남긴다(삼켜서 원인을 지우지 않는다).
const REASON_KO: Record<string, string> = {
  unauthorized: 'ADMIN_TOKEN이 맞지 않습니다 — 다시 로그인하세요',
  'bad-request': '입력값이 올바르지 않습니다 — 필수 항목을 확인하세요',
  'not-found': '대상을 찾을 수 없습니다 (이미 삭제되었거나 다른 앱의 항목입니다)',
  'nothing-to-update': '변경할 내용이 없습니다',
  'weak-secret': '시크릿이 너무 약합니다 — 콘솔이 생성한 값을 쓰세요',
  'unknown-provider': '아직 검증기가 없는 로그인 공급자입니다',
  duplicate: '이미 같은 값이 등록되어 있습니다',
  'parse-error': '서버 응답을 해석하지 못했습니다',
  network: '서버에 연결하지 못했습니다 — 네트워크·배포 상태를 확인하세요',
  error: '서버 오류가 발생했습니다',
};
const reasonKo = (reason: string, status: number): string =>
  `${REASON_KO[reason] ?? reason} ${status ? `(${status})` : ''}`.trim();

/** 웹훅 감사행의 처리 결과 — 무시·거부도 기록이라 색으로 구분한다. */
const OUTCOME: Record<string, { ko: string; tone: 'ok' | 'muted' | 'warn' | 'danger' }> = {
  applied: { ko: '반영', tone: 'ok' },
  deduped: { ko: '중복', tone: 'muted' },
  ignored: { ko: '무시', tone: 'muted' },
  rejected: { ko: '거부', tone: 'danger' },
};

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

/** ISO → `<input type="datetime-local">` 값(로컬 시각). 수정 화면에 기존 기간을 되채우려면 필요하다.
 *  toISOString()을 쓰면 UTC로 밀려 "9시간 당겨진 시각"이 폼에 뜬다. */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 상대 시각 — 절대 시각과 **함께** 쓴다. "3일 전"만으론 정확한 시점을 못 잡고, 절대값만으론 급함이 안 읽힌다. */
function ago(iso: string | null): string {
  if (!iso) return '기록 없음';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '—';
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return '방금';
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

/** 사용자 표시 라벨 — 이메일 → uuid 앞 8자. 원문 id는 호출부가 title(hover)로 항상 보존한다. */
const subjectLabel = (email: string | null, id: string): string => email?.trim() || `${id.slice(0, 8)}…`;

// CSV는 클라에서 만든다(서버 라우트 불필요 — 이미 받은 표를 그대로 내보낸다).
// 선두 BOM이 없으면 엑셀이 UTF-8을 못 알아채 한글이 깨진다.
function downloadCsv(name: string, headers: string[], rows: (string | number)[][]): void {
  const esc = (v: string | number) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ── 메뉴·앱 ↔ URL 동기화(?tab=&app=) — 새로고침·북마크·뒤로가기로 특정 화면 진입.
//    SSR 안전(window 가드 — 클라 컴포넌트지만 초기 렌더는 서버에서 돈다).
const TAB_IDS = new Set<Tab>(NAV.map((n) => n.id));
const isTab = (v: string | null): v is Tab => !!v && TAB_IDS.has(v as Tab);
function urlState(): { tab: Tab; app: string } {
  if (typeof window === 'undefined') return { tab: 'overview', app: '' };
  const q = new URLSearchParams(window.location.search);
  const t = q.get('tab');
  return { tab: isTab(t) ? t : 'overview', app: q.get('app') ?? '' };
}

// ───────────────────────── 프리미티브 ─────────────────────────

// 회색 배경 위에 흰 카드가 얕게 떠 보이도록 — 테두리 하나로만 구분하면 밀도가 높을 때 답답해진다
const card = 'rounded-card border border-border bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.04)]';
const field =
  'w-full rounded-lg border border-border bg-surface px-3 text-[13.5px] placeholder:text-fg-muted/55 transition-colors focus:border-accent';
// 한 줄 입력은 **높이를 padding으로 만들지 않는다**. 폰트별 line-height 차이 때문에 py-2로는
// 옆에 선 h-9 버튼과 1~2px씩 어긋난다. Button과 같은 h-9를 쓰면 한 줄에 나열해도 딱 맞는다.
const input = `${field} h-9`;
// 여러 줄은 높이가 내용에 따라 늘어야 하므로 h-9 대신 padding으로 만든다
const textarea = `${field} py-2`;
/** 섹션 제목 — 카드 안 소제목의 위계를 한 곳에서 통일한다 */
const sectionTitle = 'text-[13px] font-semibold tracking-tight';

function Button({
  variant = 'default',
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'ghost' | 'danger' }) {
  // h-9 고정 — 입력·버튼 높이가 어긋나면 한 줄에 나열했을 때 지저분해진다
  const base =
    'inline-flex h-9 items-center justify-center gap-1.5 rounded-lg px-3 text-[13px] font-medium transition-colors disabled:opacity-45 disabled:pointer-events-none whitespace-nowrap';
  const variants = {
    default: 'border border-border bg-surface hover:bg-muted',
    primary: 'bg-accent text-accent-fg hover:brightness-110',
    ghost: 'text-fg-muted hover:bg-muted hover:text-fg',
    danger: 'border border-danger/25 text-danger hover:bg-danger-soft',
  };
  return <button className={`${base} ${variants[variant]} ${className}`} {...props} />;
}

function Badge({
  tone = 'muted',
  children,
}: {
  tone?: 'muted' | 'accent' | 'ok' | 'warn' | 'danger';
  children: React.ReactNode;
}) {
  const tones = {
    muted: 'bg-muted text-fg-muted',
    accent: 'bg-accent-soft text-accent',
    ok: 'bg-ok-soft text-ok',
    warn: 'bg-warn-soft text-warn',
    danger: 'bg-danger-soft text-danger',
  };
  return (
    <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[11.5px] font-semibold ${tones[tone]}`}>
      {children}
    </span>
  );
}

function EmptyState({ icon: Icon, children }: { icon: React.ElementType; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 py-20 text-center">
      <Icon className="size-7 text-fg-muted/35" strokeWidth={1.5} />
      <p className="text-[13px] text-fg-muted">{children}</p>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[13px] font-medium">{label}</span>
      {hint && <span className="mt-0.5 block text-[12px] text-fg-muted">{hint}</span>}
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

/** 대시보드 지표 타일. tone으로 심각도를 색에 싣는다(숫자만 보고 넘기지 않게). */
function Stat({
  icon: Icon,
  label,
  value,
  sub,
  tone = 'muted',
}: {
  icon: React.ElementType;
  label: string;
  value: React.ReactNode;
  sub?: string;
  tone?: 'muted' | 'ok' | 'warn' | 'danger';
}) {
  const tones = { muted: 'text-fg', ok: 'text-ok', warn: 'text-warn', danger: 'text-danger' };
  return (
    <div className={`${card} p-6`}>
      <div className="flex items-center gap-1.5 text-fg-muted">
        <Icon className="size-3.5" />
        <span className="text-[12px] font-medium">{label}</span>
      </div>
      {/* 지표는 크게 — 대시보드에서 가장 먼저 읽혀야 하는 것이 숫자다 */}
      <p className={`mt-2.5 text-[26px] font-bold leading-none tracking-tight ${tones[tone]}`}>{value}</p>
      {sub && <p className="mt-2 text-[12px] leading-snug text-fg-muted">{sub}</p>}
    </div>
  );
}

/** 아직 채울 수 없는 지표 — 숨기지 않고 흐리게 남기고 **블로커를 이름으로** 붙인다.
 *  숨기면 "그런 지표가 있다는 것" 자체를 잊고, 뭉뚱그리면(“나중에”) 무엇을 하면 켜지는지 모른다. */
function Blocked({ icon: Icon, label, blocker }: { icon: React.ElementType; label: string; blocker: string }) {
  return (
    <div className={`${card} relative p-6 opacity-60`}>
      <span className="absolute right-3 top-3 rounded-md bg-muted px-1.5 py-0.5 text-[10.5px] font-bold text-fg-muted">
        {blocker}
      </span>
      <div className="flex items-center gap-1.5 text-fg-muted">
        <Icon className="size-3.5" />
        <span className="text-[12px] font-medium">{label}</span>
      </div>
      <p className="mt-2.5 text-[26px] font-bold leading-none tracking-tight text-fg-muted">—</p>
    </div>
  );
}

function CsvButton({ onClick }: { onClick: () => void }) {
  return (
    <Button onClick={onClick} title="현재 필터가 적용된 목록을 CSV로 내려받습니다">
      <Download className="size-4" /> CSV
    </Button>
  );
}

/** 세그먼트 토글 — 필터 축 하나를 한 줄로. 값이 적고 서로 배타적일 때만 쓴다(많아지면 select). */
function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: [T, string][];
}) {
  return (
    <div className="inline-flex rounded-lg border border-border bg-surface p-0.5">
      {options.map(([v, label]) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
            value === v ? 'bg-accent text-accent-fg font-medium' : 'text-fg-muted hover:text-fg'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function Pager({ offset, limit, total, onMove }: { offset: number; limit: number; total: number; onMove: (n: number) => void }) {
  if (total <= limit) return null;
  return (
    <div className="flex items-center justify-end gap-3 px-5 py-3 text-[12px] text-fg-muted">
      <Button variant="ghost" disabled={offset === 0} onClick={() => onMove(Math.max(0, offset - limit))}>
        <ChevronLeft className="size-4" /> 이전
      </Button>
      <span>
        {offset + 1}–{Math.min(offset + limit, total)} / {total.toLocaleString()}
      </span>
      <Button variant="ghost" disabled={offset + limit >= total} onClick={() => onMove(offset + limit)}>
        다음
      </Button>
    </div>
  );
}

/** 표는 좁은 화면에서 **자기 폭만 가로 스크롤**해야 한다.
 *  카드째로 스크롤시키면 제목·필터·CSV까지 밀려 나가 "지금 무엇을 보고 있는지"가 화면에서 사라진다. */
function TableScroll({ children }: { children: React.ReactNode }) {
  return <div className="overflow-x-auto">{children}</div>;
}

const th = 'whitespace-nowrap px-4 py-2.5 text-left text-[11.5px] font-semibold uppercase tracking-wide text-fg-muted';
const td = 'whitespace-nowrap px-4 py-3 text-[13px]';

// 공용 모달 — ESC·배경 클릭으로 닫고, 푸터는 규격을 강제한다(버튼 높이·정렬이 모달마다 다르면 지저분해진다).
// 실패 사유는 **푸터 좌측 인라인**에 남긴다: 모달을 닫지 않아야 방금 쓴 내용을 잃지 않는다.
function Modal({
  title,
  sub,
  wide,
  onClose,
  children,
  footer,
  error,
}: {
  title: string;
  sub?: string;
  wide?: boolean;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  error?: string;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/45 px-4 py-10 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className={`${card} w-full ${wide ? 'max-w-2xl' : 'max-w-lg'} shadow-xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-semibold tracking-tight">{title}</h2>
            {sub && <p className="mt-0.5 truncate text-[12px] text-fg-muted">{sub}</p>}
          </div>
          <button onClick={onClose} aria-label="닫기" className="shrink-0 rounded-md p-1 text-fg-muted hover:bg-muted hover:text-fg">
            <X className="size-4" />
          </button>
        </div>
        <div className="space-y-4 px-5 py-5">{children}</div>
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3.5">
            {error && <span className="mr-auto max-w-[60%] text-[12px] font-medium text-danger">{error}</span>}
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

// ───────────────────────── 루트 ─────────────────────────

export default function Ops() {
  const [token, setToken] = useState('');
  const [ready, setReady] = useState(false);
  // 토큰이 **서버에서 실제로 통했는지**. 존재 여부(token)와 분리한다 —
  // 예전에는 `if (!token)` 로만 막아서 아무 문자열이나 넣으면 콘솔 껍데기가 열렸다.
  const [verified, setVerified] = useState(false);
  const [checking, setChecking] = useState(false);
  const [err, setErr] = useState('');

  const [tab, setTab] = useState<Tab>('overview');
  const [navOpen, setNavOpen] = useState(false); // 모바일 드로어(<md). 데스크톱은 CSS로 상시 노출 — 이 값 무관
  const [apps, setApps] = useState<App[]>([]);
  const [appCode, setAppCode] = useState('');

  // 선택된 앱의 데이터 — 루트가 소유하고 탭에 내려준다(뱃지·대시보드가 이걸 공유한다)
  const [settings, setSettings] = useState<Settings | null>(null);
  const [anns, setAnns] = useState<Announcement[]>([]);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [devCount, setDevCount] = useState(0); // 가드(`[_dv_public]`)가 만든 문의 — 가린 수를 알려주기 위해
  const [showDev, setShowDev] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);
  const [booting, setBooting] = useState(true);
  const [toast, setToast] = useState('');
  // 마지막 갱신 시각 — 새로고침이 깜빡임 없이 끝나므로 표시가 없으면 갱신됐는지 확인할 방법이 없다.
  // ⚠ 초기값은 빈 문자열이어야 한다(SSR 시점에 시각을 만들면 하이드레이션이 어긋난다).
  const [updatedAt, setUpdatedAt] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  // 새로고침 축 — nonce가 바뀌면 `api` 참조가 새로 만들어지고, 자기 데이터를 스스로 부르는 탭들이
  // (`useEffect(..., [api])`) **탭 코드를 건드리지 않고** 전부 재조회된다.
  // 이게 없으면 구독·로그인설정 탭에서 새로고침을 눌러도 아무 일도 일어나지 않는다.
  const [nonce, setNonce] = useState(0);

  const flash = useCallback((m: string) => {
    setToast(m);
    setTimeout(() => setToast(''), 2400);
  }, []);

  // 테마는 밝은 쪽이 기본. OS 다크를 따라가지 않는다(콘솔이 통째로 어두워져 읽기 힘들다는 피드백).
  // 실제 적용은 layout.tsx의 인라인 스크립트가 하이드레이션 전에 끝낸다 — 여기선 현재 상태만 읽는다.
  const [dark, setDark] = useState(false);
  const toggleTheme = useCallback(() => {
    setDark((d) => {
      const next = !d;
      document.documentElement.dataset.theme = next ? 'dark' : 'light';
      try {
        localStorage.setItem('cs_theme', next ? 'dark' : 'light');
      } catch {
        /* 사생활 보호 모드 등 — 테마는 이번 세션에만 적용되고 만다 */
      }
      return next;
    });
  }, []);

  useEffect(() => {
    setToken(readToken());
    setDark(document.documentElement.dataset.theme === 'dark');
    const s = urlState();
    setTab(s.tab);
    if (s.app) setAppCode(s.app);
    setReady(true);
    const onPop = () => {
      const n = urlState();
      setTab(n.tab);
      if (n.app) setAppCode(n.app);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  /** 메뉴/앱 전환 = 상태 + URL 갱신(pushState → 뒤로가기로 복귀). 모바일 드로어도 닫는다. */
  const navigate = useCallback((next: { tab?: Tab; app?: string }) => {
    if (next.tab) setTab(next.tab);
    if (next.app) setAppCode(next.app);
    setNavOpen(false);
    const u = new URL(window.location.href);
    if (next.tab) u.searchParams.set('tab', next.tab);
    if (next.app) u.searchParams.set('app', next.app);
    window.history.pushState({}, '', u);
  }, []);

  /** 관리자 API 호출. 401이면 토큰을 버리고 즉시 입장 화면으로 되돌린다
   *  — 모든 호출이 이 함수를 거치므로, 세션 도중 토큰이 바뀌어도(회전·폐기) 한 곳에서 처리된다.
   *
   *  실패는 **한국어 사유 + HTTP status**로 정규화해서 던진다. 종전엔 서버 코드가 그대로 올라와
   *  화면에 `bad-request`가 떴고, 네트워크가 끊기면 fetch가 그냥 throw해 `Failed to fetch`가 배너에 박혔다.
   *  fetch 자체의 throw를 여기서 잡아 status 0으로 정규화하면 호출부의 실패 경로가 자연히 탄다. */
  const api = useCallback(
    async (path: string, init?: RequestInit) => {
      let res: Response;
      try {
        res = await fetch(`/api/admin/${path}`, {
          ...init,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
        });
      } catch {
        throw new Error(reasonKo('network', 0));
      }
      if (res.status === 401) {
        clearToken();
        setToken('');
        setVerified(false);
        throw new Error(reasonKo('unauthorized', 401));
      }
      const json = await res.json().catch(() => ({ ok: false, reason: 'parse-error' }));
      if (!res.ok || !json.ok) throw new Error(reasonKo(json.reason ?? 'error', res.status));
      return json;
    },
    // nonce는 쓰이지 않지만 **의존성으로는 필요하다** — 이 참조가 새로 만들어져야 탭들이 재조회한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [token, nonce],
  );

  /** 앱 목록 조회 = 토큰 검증을 겸한다(성공해야 콘솔에 들어간다). */
  const loadApps = useCallback(async () => {
    setChecking(true);
    try {
      const j = await api('apps');
      setApps(j.apps);
      setAppCode((prev) => (prev && j.apps.some((a: App) => a.appCode === prev) ? prev : (j.apps[0]?.appCode ?? '')));
      setErr('');
      saveToken(token); // 통한 토큰만 저장하고, 열 때마다 만료를 연장한다
      setVerified(true);
    } catch (e) {
      setErr(String((e as Error).message));
      setVerified(false); // 401이 아닌 실패(네트워크 등)도 통과시키지 않는다
    } finally {
      setChecking(false);
    }
  }, [api, token]);

  useEffect(() => {
    if (ready && token) void loadApps();
  }, [ready, token, loadApps]);

  /** 선택된 앱의 데이터 일괄 로드. 새로고침은 booting을 다시 켜지 않는다(깜빡임 방지). */
  const loadApp = useCallback(async () => {
    if (!appCode) {
      setBooting(false);
      return;
    }
    try {
      const [s, a, t, st] = await Promise.all([
        api(`settings?app=${appCode}`),
        api(`announcements?app=${appCode}`),
        api(`tickets?app=${appCode}${showDev ? '&internal=show' : ''}`),
        api(`stats?app=${appCode}`),
      ]);
      setSettings(s.settings);
      setAnns(a.announcements);
      setTickets(t.tickets);
      setDevCount(t.devCount ?? 0);
      setStats(st);
      setErr('');
      setUpdatedAt(new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }));
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBooting(false);
    }
  }, [api, appCode, showDev]);

  useEffect(() => {
    if (verified) void loadApp();
  }, [verified, loadApp]);

  // 새로고침 = 공통 데이터가 **끝난 뒤에** 탭 재조회를 트리거하고, 그다음에 완료를 알린다.
  // 종전엔 await 없이 곧바로 '새로고침됨'을 띄워, 데이터가 오기도 전에 끝났다는 거짓 신호를 줬다.
  // 연타 차단은 state가 아니라 ref로 — state면 이 콜백이 재생성돼 의존성이 흔들린다.
  const refreshingRef = useRef(false);
  const doRefresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      await Promise.all([loadApps(), loadApp()]);
      setNonce((n) => n + 1); // 자기 데이터를 스스로 부르는 탭(구독·로그인설정·사용자·오류)까지 갱신
      flash('새로고침됨');
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }, [loadApps, loadApp, flash]);

  // 미처리 = 대기 + 확인 중. 뱃지·대시보드·기본 필터가 전부 같은 정의를 써야 숫자가 어긋나지 않는다.
  const pendingTickets = useMemo(() => tickets.filter((t) => isPending(t.status)).length, [tickets]);

  if (!ready) return null;

  // ── 입장 ──
  if (!verified) {
    return (
      <main className="grid min-h-dvh place-items-center p-6">
        <div className={`${card} w-full max-w-sm p-8`}>
          <div className="mb-6 flex flex-col items-center gap-3 text-center">
            <div className="grid size-11 place-items-center rounded-xl bg-accent-soft">
              <Lock className="size-5 text-accent" />
            </div>
            <div>
              <h1 className="text-base font-semibold tracking-tight">{BRAND.console}</h1>
              <p className="mt-1 text-sm text-fg-muted">{BRAND.product}</p>
            </div>
          </div>

          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              const v = (new FormData(e.currentTarget).get('t') as string)?.trim();
              if (!v) return;
              setErr('');
              // 저장은 검증 성공 후에만(loadApps). 여기서 미리 저장하면 틀린 토큰이 세션에 남는다.
              setToken(v);
            }}
          >
            <input name="t" type="password" placeholder="ADMIN_TOKEN" className={input} autoFocus />
            <Button variant="primary" className="w-full" disabled={checking}>
              {checking && <Loader2 className="size-4 animate-spin" />}
              {checking ? '확인 중…' : '입장'}
            </Button>
          </form>

          {err && (
            <p className="mt-4 flex items-center gap-1.5 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
              <AlertTriangle className="size-4 shrink-0" /> {err}
            </p>
          )}
          {/* 디스크에 남는다는 걸 숨기지 않는다 — 공용 PC에선 로그아웃이 필수가 된다는 뜻이다 */}
          <p className="mt-6 text-center text-xs leading-relaxed text-fg-muted">
            이 브라우저에 {TOKEN_TTL_DAYS}일 유지됩니다(열 때마다 연장)
            <br />
            공용 PC라면 끝날 때 로그아웃하세요
          </p>
        </div>
      </main>
    );
  }

  const currentApp = apps.find((a) => a.appCode === appCode);

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[16rem_1fr]">
      {/* 모바일 드로어 배경 */}
      {navOpen && <div className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={() => setNavOpen(false)} />}

      {/* ── 사이드바 ── */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-border bg-surface p-4 transition-transform md:sticky md:top-0 md:h-dvh md:translate-x-0 ${
          navOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center gap-2">
          {/* 로고 = 대시보드 홈. 사이드바 최상단 로고를 홈으로 여기는 건 웹 관습이라,
              눌러도 아무 일이 없으면 고장으로 읽힌다(종전엔 <span>이었다). */}
          <button
            onClick={() => navigate({ tab: 'overview' })}
            className="-mx-1 flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-1 text-left transition-colors hover:bg-muted"
            title="대시보드로 이동"
          >
            <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent-soft">
              <BRAND.icon className="size-3.5 text-accent" />
            </span>
            <span className="truncate text-[14px] font-bold tracking-tight">{BRAND.product}</span>
          </button>
          <button className="shrink-0 md:hidden" onClick={() => setNavOpen(false)} aria-label="메뉴 닫기">
            <X className="size-4 text-fg-muted" />
          </button>
        </div>

        {/* 앱 선택 — 배구 콘솔엔 없는 요소(저쪽은 PROJ_CODE 고정). 모든 화면이 이 선택에 종속된다 */}
        <label className="mt-5 block">
          <span className="mb-1.5 block px-1 text-[10.5px] font-bold uppercase tracking-[0.08em] text-fg-muted/65">앱</span>
          <select
            value={appCode}
            onChange={(e) => navigate({ app: e.target.value })}
            className="h-9 w-full rounded-lg border border-border bg-bg px-2.5 text-[13.5px] font-medium"
          >
            {apps.length === 0 && <option value="">— 없음 —</option>}
            {apps.map((a) => (
              <option key={a.appCode} value={a.appCode}>
                {a.name}
              </option>
            ))}
          </select>
        </label>

        <nav className="mt-6 flex flex-1 flex-col gap-0.5">
          {NAV.map((n, i) => (
            <div key={n.id}>
              {n.grp && n.grp !== NAV[i - 1]?.grp && (
                <div className="px-1 pb-1.5 pt-5 text-[10.5px] font-bold uppercase tracking-[0.08em] text-fg-muted/65">
                  {n.grp}
                </div>
              )}
              {/* 활성 표시는 배경색 + **좌측 액센트 바**. 배경만으론 "지금 어디"가 약하게 읽힌다. */}
              <button
                onClick={() => navigate({ tab: n.id })}
                className={`relative flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-[13.5px] transition-colors ${
                  tab === n.id
                    ? 'bg-accent-soft font-semibold text-accent before:absolute before:left-0 before:top-1/2 before:h-4 before:w-[3px] before:-translate-y-1/2 before:rounded-r before:bg-accent'
                    : 'font-medium text-fg-muted hover:bg-muted hover:text-fg'
                }`}
              >
                <n.icon className="size-4 shrink-0" />
                {n.label}
                {n.id === 'tickets' && pendingTickets > 0 && (
                  <span className="ml-auto rounded-full bg-danger px-1.5 py-px text-[11px] font-bold text-white">
                    {pendingTickets}
                  </span>
                )}
                {n.id === 'errors' && (stats?.errors.rejected24h ?? 0) > 0 && (
                  <span className="ml-auto rounded-full bg-danger px-1.5 py-px text-[11px] font-bold text-white">
                    {stats!.errors.rejected24h}
                  </span>
                )}
              </button>
            </div>
          ))}
        </nav>

        {/* 점검 중이면 어느 화면에 있든 보이게 — 켜두고 잊는 사고를 막는 최후 방어선 */}
        {settings?.maintenance && (
          <button
            onClick={() => navigate({ tab: 'settings' })}
            className="mb-2 flex items-center gap-2 rounded-lg bg-danger-soft px-2.5 py-2 text-left text-xs font-medium text-danger"
          >
            <AlertTriangle className="size-4 shrink-0" />
            점검 모드 켜짐
          </button>
        )}

        <div className="flex gap-1">
          <Button
            variant="ghost"
            className="flex-1 justify-start"
            onClick={() => {
              clearToken();
              setToken('');
              setVerified(false);
            }}
          >
            <LogOut className="size-4" /> 로그아웃
          </Button>
          <Button variant="ghost" onClick={toggleTheme} aria-label={dark ? '밝은 테마로' : '어두운 테마로'} title={dark ? '밝은 테마로' : '어두운 테마로'}>
            {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>
        </div>
      </aside>

      {/* ── 본문 ── */}
      <div className="min-w-0">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-border bg-bg/85 px-6 backdrop-blur">
          <button className="md:hidden" onClick={() => setNavOpen(true)} aria-label="메뉴 열기">
            <Menu className="size-5" />
          </button>
          <div className="min-w-0">
            <h1 className="truncate text-[15px] font-bold tracking-tight">{TITLES[tab]}</h1>
            <p className="mt-0.5 truncate text-[12px] text-fg-muted">
              {currentApp ? `${currentApp.name} · ${currentApp.appCode}` : '앱 없음'}
            </p>
          </div>
          {/* "지금 보는 수치가 언제 것인가"는 값 자체만큼 중요하다 — 갱신이 조용히 끝나므로 더욱. */}
          {updatedAt && (
            <span className="ml-auto hidden shrink-0 text-[11.5px] font-medium text-fg-muted sm:inline" title="마지막으로 서버에서 데이터를 받아온 시각">
              {updatedAt} 기준
            </span>
          )}
          {/* 라벨이 바뀌므로 폭을 고정한다 — 안 그러면 누를 때마다 헤더가 밀린다. */}
          <Button
            variant="ghost"
            className={`w-[116px] shrink-0 ${updatedAt ? '' : 'ml-auto'}`}
            onClick={doRefresh}
            disabled={refreshing}
            title={refreshing ? '데이터를 다시 불러오는 중입니다' : '현재 앱의 데이터를 서버에서 다시 불러옵니다'}
          >
            <RefreshCw className={`size-4 ${refreshing ? 'animate-spin' : ''}`} />
            {refreshing ? '불러오는 중' : '새로고침'}
          </Button>
        </header>

        <main className="mx-auto max-w-5xl px-6 py-7">
          {err && (
            <div className="mb-5 flex items-center gap-2 rounded-lg bg-danger-soft px-3 py-2.5 text-[13px] font-medium text-danger">
              <AlertTriangle className="size-4 shrink-0" /> {err}
            </div>
          )}

          {booting ? (
            <EmptyState icon={Loader2}>불러오는 중…</EmptyState>
          ) : !appCode && tab !== 'apps' ? (
            <EmptyState icon={Boxes}>등록된 앱이 없습니다. “앱 관리”에서 먼저 등록하세요.</EmptyState>
          ) : tab === 'overview' ? (
            <Overview
              app={currentApp}
              settings={settings}
              anns={anns}
              tickets={tickets}
              stats={stats}
              pendingTickets={pendingTickets}
              go={(t) => navigate({ tab: t })}
            />
          ) : tab === 'anns' ? (
            <Announcements api={api} appCode={appCode} rows={anns} reload={loadApp} onError={setErr} flash={flash} />
          ) : tab === 'tickets' ? (
            <Tickets
              api={api}
              appCode={appCode}
              rows={tickets}
              devCount={devCount}
              showDev={showDev}
              setShowDev={setShowDev}
              reload={loadApp}
              onError={setErr}
              flash={flash}
            />
          ) : tab === 'subjects' ? (
            <Subjects api={api} appCode={appCode} onError={setErr} />
          ) : tab === 'billing' ? (
            <Billing api={api} appCode={appCode} onError={setErr} flash={flash} />
          ) : tab === 'errors' ? (
            <Errors stats={stats} />
          ) : tab === 'settings' ? (
            <SettingsTab api={api} appCode={appCode} s={settings} reload={loadApp} onError={setErr} flash={flash} />
          ) : (
            <AppsTab api={api} apps={apps} reload={loadApps} onError={setErr} flash={flash} />
          )}
        </main>
      </div>

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-fg px-4 py-2 text-sm font-medium text-bg shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}

type Api = (path: string, init?: RequestInit) => Promise<any>;
type Common = { api: Api; reload: () => Promise<void>; onError: (m: string) => void; flash: (m: string) => void };

// ───────────────────────── 대시보드 ─────────────────────────

/** 운영 알림 — 임계 판정은 서버(`/api/admin/stats`)가 한다. 화면이 판정하면 임계가 UI에 흩어진다.
 *  알림이 없을 때 **아무것도 안 그리지 않는다**: "이상 없음"을 봐야 화면이 죽은 게 아님을 안다. */
function Alerts({ rows, go }: { rows: Alert[]; go: (t: Tab) => void }) {
  if (!rows.length) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-ok/25 bg-ok-soft px-4 py-3 text-[13px] font-medium text-ok">
        <ShieldCheck className="size-4 shrink-0" /> 이상 징후 없음
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {rows.map((a) => {
        const crit = a.severity === 'crit';
        return (
          <button
            key={a.key}
            onClick={() => a.tab && go(a.tab)}
            disabled={!a.tab}
            className={`flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors ${
              crit ? 'border-danger/30 bg-danger-soft' : 'border-warn/30 bg-warn-soft'
            } ${a.tab ? 'hover:brightness-[0.98]' : 'cursor-default'}`}
          >
            {crit ? (
              <OctagonAlert className="size-4 shrink-0 text-danger" />
            ) : (
              <AlertTriangle className="size-4 shrink-0 text-warn" />
            )}
            <span className="min-w-0">
              <span className={`block text-[13px] font-semibold ${crit ? 'text-danger' : 'text-warn'}`}>{a.label}</span>
              <span className="mt-0.5 block text-[12px] text-fg-muted">{a.detail}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** 인프라 배선 — 디스코드 웹훅·RC 키는 없으면 **조용히 no-op**이라 안 붙은 줄 모른다.
 *  "미설정"을 실패로 칠하지 않는다: 의도적으로 안 붙인 것들이 있다(Upstash·Sentry). 대신 결과를 적는다. */
function InfraRow({ ok, label, on, off }: { ok: boolean; label: string; on: string; off: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-border py-2.5 last:border-0">
      <span className="flex items-center gap-2 text-[13px] font-medium">
        <span className={`size-1.5 shrink-0 rounded-full ${ok ? 'bg-ok' : 'bg-fg-muted/40'}`} />
        {label}
      </span>
      <span className={`text-[12px] ${ok ? 'text-fg-muted' : 'text-warn'}`}>{ok ? on : off}</span>
    </div>
  );
}

/** 날짜라벨 'YYYY-MM-DD' → 'M/D'. */
const mdOf = (ymd: string): string => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;

/**
 * 활성 사용자 — DAU/WAU/MAU + 일별 추이 + 요일 평균.
 *
 * ⚠ 이 화면의 핵심은 **숫자가 아니라 "모았나"다.** 수집 전에 0을 그리면
 *   없는 데이터를 있는 데이터처럼 단언하게 된다(배구 서버가 요일 차트에서 실제로 했던 거짓말).
 *   그래서 판정 축은 표본 수가 아니라 서버가 계산한 **수집 경과일**이다.
 */
function Activity({ a }: { a: Stats['activity'] }) {
  // 수집 전 — 차트를 아예 그리지 않고 무엇을 하면 켜지는지를 적는다.
  if (a.coverageDays === 0) {
    return (
      <section className={`${card} p-6`}>
        <h2 className={`mb-2 ${sectionTitle}`}>활성 사용자</h2>
        <p className="text-[13px] leading-relaxed text-fg-muted">
          아직 수집된 기록이 없습니다 — <strong className="font-medium text-fg">0명이라는 뜻이 아닙니다.</strong>
          <br />
          앱이 SDK 2026-09-01 이상으로 재배포되어 부팅 시 세션을 실어 보내기 시작해야 쌌입니다.
        </p>
      </section>
    );
  }

  const max = Math.max(1, ...a.series.map((d) => d.n));
  const wMax = Math.max(1, ...a.weekday.map((w) => w.avg ?? 0));
  const first = a.series[0];
  const last = a.series[a.series.length - 1];

  return (
    <section className={`${card} p-6`}>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className={sectionTitle}>활성 사용자</h2>
        <span className="text-[12px] text-fg-muted">수집 {a.coverageDays}일차</span>
      </div>

      {/* 헤드라인 3개 — 차트보다 먼저 읽힐 숫자 */}
      <div className="mb-6 grid grid-cols-3 gap-3">
        {(
          [
            ['오늘 (DAU)', a.dau],
            ['7일 (WAU)', a.wau],
            ['30일 (MAU)', a.mau],
          ] as [string, number][]
        ).map(([label, v]) => (
          <div key={label} className="rounded-md bg-muted px-3 py-2.5">
            <p className="text-[11.5px] font-medium text-fg-muted">{label}</p>
            <p className="mt-1 text-[22px] font-bold leading-none tracking-tight">{v.toLocaleString()}</p>
          </div>
        ))}
      </div>

      {/* 일별 추이 — 단일 계열이라 범례가 필요 없다(제목이 계열 이름이다). */}
      <p className="mb-2 text-[12px] font-medium text-fg-muted">최근 {a.series.length}일 일별 활성자</p>
      <div className="flex h-24 items-stretch gap-[2px]">
        {a.series.map((d) => {
          const isToday = d.day === last?.day;
          return (
            <div
              key={d.day}
              className="flex flex-1 flex-col justify-end"
              title={`${d.day} · ${d.n}명`}
            >
              <div
                className={`rounded-t-[4px] ${d.n === 0 ? 'bg-border' : isToday ? 'bg-accent' : 'bg-accent/55'}`}
                /* 0은 높이 2px로 깔아 둔다 — "활성 0"과 "칸이 없음"이 달라 보여야 한다 */
                style={{ height: d.n === 0 ? '2px' : `${Math.max((d.n / max) * 100, 8)}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-fg-muted">
        <span>{first ? mdOf(first.day) : ''}</span>
        <span>최대 {max}명</span>
        <span>{last ? mdOf(last.day) : ''}</span>
      </div>

      {/* 요일 평균 — 표본이 모자라면 그리지 않는다 */}
      <div className="mt-6 border-t border-border pt-5">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-[12px] font-medium text-fg-muted">요일별 평균 (최근 {a.windowDays}일)</p>
          {!a.chartReady && <span className="text-[11.5px] text-warn">수집 중 {a.coverageDays}/14일</span>}
        </div>
        {a.chartReady ? (
          <div className="flex h-20 items-stretch gap-1.5">
            {a.weekday.map((w) => (
              <div key={w.dow} className="flex flex-1 flex-col justify-end" title={`${w.label} · 평균 ${w.avg ?? 0}명 · 표본 ${w.samples}일`}>
                <span className="mb-1 text-center text-[11px] font-medium tabular-nums text-fg-muted">
                  {w.avg === null ? '—' : w.avg}
                </span>
                <div
                  className="rounded-t-[4px] bg-accent/55"
                  style={{ height: w.avg === null ? '2px' : `${Math.max((w.avg / wMax) * 100, 8)}%` }}
                />
                <span className="mt-1 text-center text-[11px] text-fg-muted">{w.label}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[13px] text-fg-muted">
            요일당 2일치(2주)는 모여야 그립니다. 그 전에 그리면 우연을 경향으로 읽게 됩니다.
          </p>
        )}
      </div>
    </section>
  );
}

function Overview({
  app,
  settings,
  anns,
  tickets,
  stats,
  pendingTickets,
  go,
}: {
  app?: App;
  settings: Settings | null;
  anns: Announcement[];
  tickets: Ticket[];
  stats: Stats | null;
  pendingTickets: number;
  go: (t: Tab) => void;
}) {
  const now = Date.now();
  const live = anns.filter(
    (a) => new Date(a.startsAt).getTime() <= now && (!a.endsAt || new Date(a.endsAt).getTime() >= now),
  ).length;
  const kpi = stats?.kpi;
  // 24시간 접수량 — 앱별 캡에 얼마나 근접했는지가 곧 "정상 문의가 막힐 위험"이다
  const since = now - 24 * 60 * 60 * 1000;
  const last24 = kpi?.tickets24h ?? tickets.filter((t) => new Date(t.createdAt).getTime() >= since).length;
  const cap = app?.ticketDailyCap ?? 0;
  const capTone = cap && last24 >= cap ? 'danger' : cap && last24 >= cap * 0.7 ? 'warn' : 'muted';
  const oldestH = kpi?.oldestPendingHours ?? 0;

  return (
    <div className="space-y-6">
      <Alerts rows={stats?.alerts ?? []} go={go} />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          icon={MessageSquare}
          label="미처리 문의"
          value={pendingTickets}
          sub={
            pendingTickets
              ? oldestH >= 24
                ? `가장 오래된 것 ${Math.floor(oldestH / 24)}일 경과`
                : '대기 + 확인 중'
              : '모두 처리됨'
          }
          tone={pendingTickets ? 'warn' : 'ok'}
        />
        <Stat
          icon={Users}
          label="사용자"
          value={kpi ? kpi.subjects.toLocaleString() : '—'}
          /* ⚠ 예전엔 여기에 "최근 14일 접속"을 적었는데, lastSeenAt이 등록 시점에만 갱신돼
             실제로는 "최근 14일 신규 설치"였다. 활성은 아래 전용 섹션이 맡는다. */
          sub={kpi ? `신규 +${kpi.subjectsNew24h} (24시간)` : undefined}
        />
        <Stat
          icon={CreditCard}
          label="활성 구독"
          value={kpi ? kpi.subscribers.toLocaleString() : '—'}
          tone={kpi?.subscribers ? 'ok' : 'muted'}
          sub="지금 권한이 살아 있는 사용자"
        />
        <Stat
          icon={Inbox}
          label="24시간 접수"
          value={`${last24} / ${cap}`}
          sub={capTone === 'danger' ? '캡 도달 — 신규 접수가 429로 막힙니다' : '앱별 일일 캡'}
          tone={capTone}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat icon={Megaphone} label="노출 중 공지" value={live} sub={`전체 ${anns.length}건`} />
        <Stat
          icon={Wrench}
          label="서비스 상태"
          value={settings?.maintenance ? '점검 중' : '정상'}
          sub={settings?.maintenance ? '전 사용자 진입 차단' : app?.active ? '앱 활성' : '앱 비활성'}
          tone={settings?.maintenance || !app?.active ? 'danger' : 'ok'}
        />
        <Stat
          icon={OctagonAlert}
          label="웹훅 거부 (24h)"
          value={stats?.errors.rejected24h ?? '—'}
          tone={stats?.errors.rejected24h ? 'danger' : 'muted'}
          sub="거부된 만큼 결제가 권한에 안 붙었습니다"
        />
        {/* 아직 못 채우는 지표는 지우지 않고 블로커를 이름으로 붙여 남긴다 */}
        <Blocked icon={Bell} label="앱 크래시" blocker="계측 후" />
      </div>

      {stats && <Activity a={stats.activity} />}

      {/* 조용히 no-op인 배선을 화면에 드러낸다 — 값이 아니라 붙었는지 여부만 서버가 알려준다 */}
      <section className={`${card} p-6`}>
        <h2 className={`mb-2 ${sectionTitle}`}>배선 상태</h2>
        <p className="mb-3 text-[12px] text-fg-muted">
          없어도 서버는 조용히 동작합니다 — 그래서 안 붙은 줄 모르는 것들입니다.
        </p>
        {stats ? (
          <div>
            <InfraRow
              ok={stats.infra.discord}
              label="문의 디스코드 알림"
              on="연결됨"
              off="미설정 — 콘솔을 열기 전엔 문의가 온 줄 모릅니다"
            />
            <InfraRow ok={stats.infra.rcWebhook} label="RC 웹훅 시크릿" on="설정됨" off="미설정 — 웹훅이 전부 401로 거부됩니다" />
            <InfraRow
              ok={stats.infra.rcPullKey}
              label="RC pull 키"
              on="설정됨"
              off="미설정 — 웹훅이 유실되면 복구 경로가 없습니다"
            />
            <InfraRow ok={stats.infra.ratelimit} label="레이트리밋(Upstash)" on="연결됨" off="미설정 — 방어선은 문의 일일 캡뿐입니다" />
            <InfraRow ok={stats.infra.sentry} label="오류 수집(Sentry)" on="연결됨" off="미설정 — 서버 오류가 로그에만 남습니다" />
          </div>
        ) : (
          <p className="text-[13px] text-fg-muted">불러오는 중…</p>
        )}
      </section>

      {/* 진입 게이트 요약 — 값이 비어 있으면 게이트가 없는 것이라 명시한다(무설정과 무효를 헷갈리지 않게) */}
      <section className={`${card} p-6`}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className={sectionTitle}>진입 게이트</h2>
          <Button variant="ghost" onClick={() => go('settings')}>
            설정으로
          </Button>
        </div>
        <dl className="grid gap-3 sm:grid-cols-2">
          {(
            [
              ['최소 버전 (강제 업데이트)', settings?.minVersion],
              ['최신 버전 (안내)', settings?.latestVersion],
              ['Android 스토어', settings?.androidStoreUrl],
              ['iOS 스토어', settings?.iosStoreUrl],
            ] as [string, string | null | undefined][]
          ).map(([k, v]) => (
            <div key={k} className="flex items-baseline justify-between gap-3 border-b border-border pb-2 last:border-0">
              <dt className="shrink-0 text-sm text-fg-muted">{k}</dt>
              <dd className={`truncate text-sm ${v ? 'font-medium' : 'text-fg-muted/60'}`}>{v || '미설정 (게이트 없음)'}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className={sectionTitle}>최근 문의</h2>
          <Button variant="ghost" onClick={() => go('tickets')}>
            전체 보기
          </Button>
        </div>
        {tickets.length ? (
          <div className={`${card} divide-y divide-border`}>
            {tickets.slice(0, 5).map((t) => (
              <div key={t.id} className="flex items-center gap-3 px-4 py-3">
                <Badge tone={STATUS_TONE[t.status] ?? 'muted'}>{statusLabel(t.status, !!t.subjectId)}</Badge>
                <span className="min-w-0 flex-1 truncate text-sm">{t.content}</span>
                <span className="shrink-0 text-xs text-fg-muted">{fmt(t.createdAt)}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className={card}>
            <EmptyState icon={Inbox}>접수된 문의가 없습니다.</EmptyState>
          </div>
        )}
      </section>
    </div>
  );
}

// ───────────────────────── 공지 ─────────────────────────

const EMPTY_ANN = { kind: 'notice', title: '', body: '', pinned: false, startsAt: '', endsAt: '' };
type AnnDraft = typeof EMPTY_ANN;

/** 공지의 현재 노출 상태 — 목록과 상세가 같은 판정을 써야 한다(한쪽만 "노출 중"이면 신뢰를 잃는다). */
function annState(a: Announcement, now: number): { label: string; tone: 'muted' | 'ok' | 'warn'; ended: boolean } {
  if (a.endsAt && new Date(a.endsAt).getTime() < now) return { label: '종료', tone: 'muted', ended: true };
  if (new Date(a.startsAt).getTime() <= now) return { label: '노출 중', tone: 'ok', ended: false };
  return { label: '예정', tone: 'warn', ended: false };
}

/** 등록·수정이 공유하는 입력부. 갈라두면 필드를 추가할 때 한쪽만 고치는 사고가 난다. */
function AnnFields({ value, onChange }: { value: AnnDraft; onChange: (v: AnnDraft) => void }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <select
          value={value.kind}
          onChange={(e) => onChange({ ...value, kind: e.target.value })}
          className="h-9 rounded-lg border border-border bg-surface px-3 text-[13px]"
        >
          <option value="notice">공지</option>
          <option value="event">이벤트</option>
          <option value="update">업데이트</option>
        </select>
        <input
          placeholder="제목"
          value={value.title}
          onChange={(e) => onChange({ ...value, title: e.target.value })}
          className={`${input} min-w-60 flex-1`}
          maxLength={200}
        />
        <button
          type="button"
          onClick={() => onChange({ ...value, pinned: !value.pinned })}
          className={`inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-[13px] font-medium transition-colors ${
            value.pinned ? 'border-accent bg-accent-soft text-accent' : 'border-border text-fg-muted hover:bg-muted'
          }`}
        >
          <Pin className="size-4" /> 상단 고정
        </button>
      </div>

      <textarea
        placeholder="내용 (줄바꿈은 앱에서 그대로 보입니다)"
        value={value.body}
        onChange={(e) => onChange({ ...value, body: e.target.value })}
        className={`${textarea} min-h-48 resize-y leading-relaxed`}
        maxLength={10000}
      />

      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="text-fg-muted">노출 기간</span>
        <input
          type="datetime-local"
          value={value.startsAt}
          onChange={(e) => onChange({ ...value, startsAt: e.target.value })}
          className="h-9 rounded-lg border border-border bg-surface px-2.5 text-[13px]"
        />
        <span className="text-fg-muted">~</span>
        <input
          type="datetime-local"
          value={value.endsAt}
          onChange={(e) => onChange({ ...value, endsAt: e.target.value })}
          className="h-9 rounded-lg border border-border bg-surface px-2.5 text-[13px]"
        />
        <span className="text-[12px] text-fg-muted">비우면 즉시 시작 · 무기한</span>
      </div>
    </div>
  );
}

// 목록 → (더블클릭) 상세·수정 / (등록 버튼) 새 공지.
// 전에는 등록 폼이 목록 위에 상주하고 본문 전체가 모든 행에 펼쳐져 있어, 공지가 늘수록
// "지금 뭐가 걸려 있나"를 한눈에 볼 수 없었다. 목록의 일은 **훑는 것**이고 편집은 별도 화면의 일이다.
function Announcements({
  api,
  appCode,
  rows,
  reload,
  onError,
  flash,
}: Common & { appCode: string; rows: Announcement[] }) {
  const [view, setView] = useState<{ mode: 'list' } | { mode: 'create' } | { mode: 'detail'; id: string }>({
    mode: 'list',
  });
  const [draft, setDraft] = useState<AnnDraft>(EMPTY_ANN);
  const [busy, setBusy] = useState(false);

  const now = Date.now();
  // 상세 중 다른 곳에서 삭제됐다면 원본이 사라진다 — 그 경우 목록으로 되돌린다(빈 화면을 남기지 않는다)
  const current = view.mode === 'detail' ? (rows.find((a) => a.id === view.id) ?? null) : null;
  const draftOf = (a: Announcement): AnnDraft => ({
    kind: a.kind,
    title: a.title,
    body: a.body,
    pinned: a.pinned,
    startsAt: toLocalInput(a.startsAt),
    endsAt: toLocalInput(a.endsAt),
  });

  // 저장하지 않은 편집이 있는지 — 화면을 뜨기 전에 물어보려면 필요하다
  const dirty = current
    ? JSON.stringify(draft) !== JSON.stringify(draftOf(current))
    : view.mode === 'create' && (draft.title.trim() !== '' || draft.body.trim() !== '');

  const openDetail = (a: Announcement) => {
    setDraft(draftOf(a));
    onError('');
    setView({ mode: 'detail', id: a.id });
  };
  const openCreate = () => {
    setDraft(EMPTY_ANN);
    onError('');
    setView({ mode: 'create' });
  };
  const backToList = () => {
    if (dirty && !confirm('저장하지 않은 내용이 있습니다. 목록으로 돌아갈까요?')) return;
    onError('');
    setView({ mode: 'list' });
  };

  const create = async () => {
    if (!draft.title.trim() || !draft.body.trim()) return onError('제목과 내용을 채우세요');
    setBusy(true);
    try {
      await api('announcements', { method: 'POST', body: JSON.stringify({ appCode, ...draft }) });
      onError('');
      await reload();
      flash('공지를 발행했습니다');
      setDraft(EMPTY_ANN);
      setView({ mode: 'list' });
    } catch (e) {
      onError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  // 서버는 처음부터 PATCH를 지원했다. 오타 하나 때문에 지우고 다시 쓰면 id가 바뀌는데,
  // id는 앱의 읽음 처리 키라 **이미 읽은 사람에게도 다시 안읽음으로 뜬다.** 수정은 삭제-재작성으로 대체할 수 없다.
  const save = async (id: string) => {
    if (!draft.title.trim() || !draft.body.trim()) return onError('제목과 내용을 채우세요');
    setBusy(true);
    try {
      // 폼 전체를 보낸다 — endsAt을 비우면 서버가 null(무기한)로 되돌린다.
      await api('announcements', { method: 'PATCH', body: JSON.stringify({ id, ...draft }) });
      onError('');
      await reload();
      flash('수정했습니다');
      setView({ mode: 'list' });
    } catch (e) {
      onError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (a: Announcement) => {
    if (!confirm(`"${a.title}"\n\n이 공지를 삭제할까요? 되돌릴 수 없습니다.`)) return;
    setBusy(true);
    try {
      await api(`announcements?id=${a.id}`, { method: 'DELETE' });
      onError('');
      await reload();
      flash('삭제했습니다');
      setView({ mode: 'list' });
    } catch (e) {
      onError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  // ── 등록 ──
  if (view.mode === 'create') {
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={backToList} disabled={busy}>
            <ChevronLeft className="size-4" /> 목록
          </Button>
          <h2 className={sectionTitle}>새 공지</h2>
          <Button variant="primary" className="ml-auto" onClick={create} disabled={busy}>
            <Plus className="size-4" /> 발행
          </Button>
        </div>
        <section className={`${card} p-6`}>
          <AnnFields value={draft} onChange={setDraft} />
        </section>
      </div>
    );
  }

  // ── 상세·수정 ──
  if (view.mode === 'detail' && current) {
    const st = annState(current, now);
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={backToList} disabled={busy}>
            <ChevronLeft className="size-4" /> 목록
          </Button>
          <Badge tone={st.tone}>{st.label}</Badge>
          {current.pinned && (
            <Badge tone="accent">
              <Pin className="mr-1 size-3" /> 고정
            </Badge>
          )}
          <div className="ml-auto flex gap-2">
            <Button variant="danger" onClick={() => remove(current)} disabled={busy}>
              <Trash2 className="size-4" /> 삭제
            </Button>
            <Button variant="primary" onClick={() => save(current.id)} disabled={busy || !dirty}>
              <Check className="size-4" /> 저장
            </Button>
          </div>
        </div>

        <section className={`${card} p-6`}>
          <AnnFields value={draft} onChange={setDraft} />
        </section>

        {dirty && <p className="text-[12px] text-warn">저장하지 않은 내용이 있습니다.</p>}
      </div>
    );
  }

  // ── 목록 ──
  return (
    <section className={card}>
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
        <div className="flex items-baseline gap-2">
          <h2 className={sectionTitle}>공지 목록</h2>
          <span className="text-[12px] text-fg-muted">{rows.length}건</span>
        </div>
        <Button variant="primary" onClick={openCreate}>
          <Plus className="size-4" /> 등록
        </Button>
      </div>

      {rows.length ? (
        <>
          <ul className="divide-y divide-border">
            {rows.map((a) => {
              const st = annState(a, now);
              return (
                <li key={a.id}>
                  {/* 더블클릭이 진입 수단이지만 그것만이면 키보드로는 못 연다 — Enter도 같이 받는다 */}
                  <div
                    role="button"
                    tabIndex={0}
                    onDoubleClick={() => openDetail(a)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') openDetail(a);
                    }}
                    title="더블클릭하면 상세·수정 화면으로 이동합니다"
                    className={`flex cursor-pointer select-none items-center gap-2.5 px-5 py-3 transition-colors hover:bg-muted focus:bg-muted focus:outline-none ${
                      st.ended ? 'opacity-55' : ''
                    }`}
                  >
                    <Badge tone={st.tone}>{st.label}</Badge>
                    {a.pinned && <Pin className="size-3.5 shrink-0 text-accent" />}
                    <span className="truncate text-[13.5px] font-medium">{a.title}</span>
                    <Badge>{KIND_KO[a.kind] ?? a.kind}</Badge>
                    <span className="ml-auto shrink-0 text-[12px] text-fg-muted">
                      {fmt(a.startsAt)} ~ {a.endsAt ? fmt(a.endsAt) : '무기한'}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="border-t border-border px-5 py-2.5 text-[12px] text-fg-muted">
            행을 더블클릭하면 상세·수정 화면으로 이동합니다.
          </p>
        </>
      ) : (
        <EmptyState icon={Megaphone}>발행된 공지가 없습니다. 우측 상단 “등록”으로 첫 공지를 올리세요.</EmptyState>
      )}
    </section>
  );
}

// ───────────────────────── 문의 ─────────────────────────

const TICKET_STATUS_FILTERS: [string, string][] = [
  ['pending', '미처리'],
  ['', '전체'],
  ['open', '대기'],
  ['reviewing', '확인 중'],
  ['replied', '답변함'],
  ['resolved', '완료'],
];

function Tickets({
  api,
  appCode,
  rows,
  devCount,
  showDev,
  setShowDev,
  reload,
  onError,
  flash,
}: Common & {
  appCode: string;
  rows: Ticket[];
  devCount: number;
  showDev: boolean;
  setShowDev: (v: boolean) => void;
}) {
  // 기본값은 **미처리**(대기+확인 중) — 목록의 기본 질문은 "지금 손이 필요한 게 뭔가"다.
  // '전체'가 기본이면 처리 끝난 문의가 상단을 채워 그 질문에 답하지 못한다.
  const [status, setStatus] = useState('pending');
  const [category, setCategory] = useState('');
  const [sel, setSel] = useState<Ticket | null>(null);

  const filtered = useMemo(
    () =>
      rows.filter((t) => {
        if (category && t.category !== category) return false;
        if (status === 'pending') return isPending(t.status);
        if (status && t.status !== status) return false;
        return true;
      }),
    [rows, status, category],
  );

  // 선택된 티켓은 목록이 갱신되면 **최신 행으로 다시 집어온다** — 저장 후 모달이 옛 값을 들고 있으면
  // 방금 바꾼 상태가 되돌아간 것처럼 보인다.
  const current = sel ? (rows.find((t) => t.id === sel.id) ?? null) : null;

  const exportCsv = () =>
    downloadCsv(
      `tickets-${appCode}-${status || 'all'}${category ? `-${category}` : ''}${showDev ? '-withdev' : ''}.csv`,
      ['접수', '유형', '상태', '작성자', '플랫폼', '앱버전', '내용', '답변/메모', '답변시각'],
      filtered.map((t) => [
        t.createdAt,
        CATEGORY_KO[t.category] ?? t.category,
        statusLabel(t.status, !!t.subjectId),
        t.subjectId ? (t.subjectEmail ?? '회원') : '익명',
        t.platform ?? '',
        t.appVersion ?? '',
        t.content,
        t.reply ?? '',
        t.repliedAt ?? '',
      ]),
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select value={status} onChange={(e) => setStatus(e.target.value)} className={`${input} w-auto min-w-32`}>
          {TICKET_STATUS_FILTERS.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
        <select value={category} onChange={(e) => setCategory(e.target.value)} className={`${input} w-auto min-w-28`}>
          <option value="">전체 유형</option>
          {Object.entries(CATEGORY_KO).map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
        <span className="text-[12px] text-fg-muted">
          {filtered.length} / {rows.length}건
        </span>
        <div className="ml-auto flex items-center gap-2">
          {/* 가드가 만든 문의는 운영 문의와 같은 테이블에 쌓인다(로컬 dev가 프로덕션 DB를 쓴다).
              숨기고 말이 없으면 숫자가 조용히 달라지므로, **가린 건수를 함께** 보여준다. */}
          {devCount > 0 && (
            <Button
              variant={showDev ? 'primary' : 'default'}
              onClick={() => setShowDev(!showDev)}
              title="tools/_dv_public.ts 가드가 접수한 문의입니다. 운영 문의가 아닙니다."
            >
              가드 문의 {devCount}건 {showDev ? '숨기기' : '보기'}
            </Button>
          )}
          <CsvButton onClick={exportCsv} />
        </div>
      </div>

      <p className="text-[12px] text-fg-muted">
        <strong className="text-accent">회원</strong> 문의는 답변이 앱의 “내 문의 내역”에 그대로 노출되고,{' '}
        <strong>익명</strong> 문의는 전달 경로가 없어 내부 메모로만 남습니다.
      </p>

      {filtered.length ? (
        <div className={card}>
          <TableScroll>
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-border">
                  <th className={th}>상태</th>
                  <th className={th}>유형</th>
                  <th className={th}>작성자</th>
                  <th className={`${th} w-full`}>내용</th>
                  <th className={th}>접수</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((t) => (
                  <tr
                    key={t.id}
                    onClick={() => setSel(t)}
                    className="cursor-pointer border-b border-border last:border-0 hover:bg-muted"
                  >
                    <td className={td}>
                      <Badge tone={STATUS_TONE[t.status] ?? 'muted'}>{statusLabel(t.status, !!t.subjectId)}</Badge>
                    </td>
                    <td className={`${td} text-fg-muted`}>{CATEGORY_KO[t.category] ?? t.category}</td>
                    <td className={td} title={t.subjectId ?? '익명 접수'}>
                      {t.subjectId ? (
                        t.subjectDeleted ? (
                          <span className="text-fg-muted">탈퇴한 회원</span>
                        ) : (
                          <span className="text-accent">{subjectLabel(t.subjectEmail, t.subjectId)}</span>
                        )
                      ) : (
                        <span className="text-fg-muted">익명</span>
                      )}
                    </td>
                    {/* 내용만 줄바꿈 예외 — 나머지 칸은 nowrap이라 표 폭이 셀에서 만들어진다.
                        ⚠ max-width를 <td>에 걸면 브라우저가 "제안"으로만 취급한다(table-layout:auto).
                        실제로 잘리게 하려면 **안쪽 블록**에 걸어야 한다. */}
                    <td className="px-4 py-3 text-[13px]">
                      <div className="max-w-md truncate">{t.content}</div>
                    </td>
                    <td className={`${td} text-fg-muted`} title={fmt(t.createdAt)}>
                      {ago(t.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </div>
      ) : (
        <div className={card}>
          <EmptyState icon={Inbox}>
            {status === 'pending' ? '손이 필요한 문의가 없습니다. 상태를 “전체”로 바꿔 지난 문의를 볼 수 있습니다.' : '조건에 맞는 문의가 없습니다.'}
          </EmptyState>
        </div>
      )}

      {current && (
        <TicketModal
          t={current}
          api={api}
          appCode={appCode}
          reload={reload}
          onError={onError}
          flash={flash}
          onClose={() => setSel(null)}
        />
      )}
    </div>
  );
}

/** 문의 상세 — 답변과 상태를 **한 번에** 저장한다.
 *  상태를 입력의 부수효과로 바꾸지 않는다: 메모를 썼다고 자동으로 '답변함'이 되면
 *  "적어두기만 하고 아직 답은 안 함"을 표현할 수 없다. */
function TicketModal({
  t,
  api,
  appCode,
  reload,
  onError,
  flash,
  onClose,
}: Omit<Common, 'reload'> & {
  t: Ticket;
  appCode: string;
  reload: () => Promise<void>;
  onClose: () => void;
}) {
  const origReply = t.reply ?? '';
  const [reply, setReply] = useState(origReply);
  const [status, setStatus] = useState(t.status);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const dirty = reply !== origReply || status !== t.status;
  const member = !!t.subjectId && !t.subjectDeleted;

  const save = async () => {
    setBusy(true);
    setErr('');
    try {
      await api('tickets', { method: 'PATCH', body: JSON.stringify({ id: t.id, app: appCode, reply, status }) });
      await reload();
      onError('');
      flash(reply !== origReply ? '답변을 저장했습니다' : '상태를 변경했습니다');
      onClose();
    } catch (e) {
      // 실패해도 모달을 닫지 않는다 — 방금 쓴 답변을 잃지 않게.
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      wide
      title="문의 상세"
      sub={`${CATEGORY_KO[t.category] ?? t.category} · ${t.subjectId ? subjectLabel(t.subjectEmail, t.subjectId) : '익명'} · ${fmt(t.createdAt)}`}
      onClose={onClose}
      error={err}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            닫기
          </Button>
          <Button variant="primary" onClick={save} disabled={!dirty || busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
            {busy ? '저장 중' : '저장'}
          </Button>
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={STATUS_TONE[t.status] ?? 'muted'}>{statusLabel(t.status, !!t.subjectId)}</Badge>
        {t.subjectId ? (
          <Badge tone={t.subjectDeleted ? 'muted' : 'accent'}>
            {t.subjectDeleted ? '탈퇴한 회원' : (t.subjectEmail ?? '회원')}
          </Badge>
        ) : (
          <Badge>익명</Badge>
        )}
        <span className="text-[12px] text-fg-muted">
          {t.platform ?? '—'}
          {t.appVersion ? ` · v${t.appVersion}` : ''}
        </span>
        {t.repliedAt && <span className="text-[12px] text-fg-muted">답변 {fmt(t.repliedAt)}</span>}
      </div>

      <div className="rounded-lg border border-border bg-bg p-4">
        <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed">{t.content}</p>
      </div>

      <Field
        label={member ? '답변' : '내부 메모'}
        hint={
          member
            ? '여기 쓴 내용은 앱의 “내 문의 내역”에 그대로 노출됩니다.'
            : t.subjectDeleted
              ? '탈퇴한 회원입니다 — 답변을 써도 전달되지 않습니다.'
              : '익명 접수라 사용자에게 전달할 경로가 없습니다. 기록으로만 남습니다.'
        }
      >
        {/* 한 줄 input이 아니라 textarea — 4000자를 한 줄에 쓰게 하면 문단을 나눌 수 없다 */}
        <textarea
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          maxLength={4000}
          rows={6}
          className={`${textarea} ${member ? 'border-accent/50' : ''}`}
          placeholder={member ? '사용자에게 보일 답변을 씁니다' : '운영자만 보는 메모'}
        />
      </Field>

      <Field label="상태" hint="저장을 눌러야 반영됩니다. 답변을 쓰지 않고 상태만 바꿔도 됩니다.">
        <select value={status} onChange={(e) => setStatus(e.target.value)} className={input}>
          {STATUS_OPTIONS.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
      </Field>

      {dirty && <p className="text-[12px] text-warn">저장하지 않은 내용이 있습니다</p>}
    </Modal>
  );
}

// ───────────────────────── 사용자 ─────────────────────────

const SUBJ_LIMIT = 50;

function Subjects({ api, appCode, onError }: { api: Api; appCode: string; onError: (m: string) => void }) {
  const [status, setStatus] = useState<'all' | 'active' | 'inactive' | 'withdrawn'>('all');
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<SubjectRow[]>([]);
  const [total, setTotal] = useState(0);
  const [activeDays, setActiveDays] = useState(14);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    api(`subjects?app=${appCode}&status=${status}&limit=${SUBJ_LIMIT}&offset=${offset}`)
      .then((j) => {
        if (!live) return;
        setRows(j.subjects);
        setTotal(j.total);
        setActiveDays(j.activeDays);
      })
      .catch((e) => live && onError(String((e as Error).message)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [api, appCode, status, offset, onError]);

  const pick = (s: typeof status) => {
    setStatus(s);
    setOffset(0); // 필터를 바꾸면 1페이지로 — 안 그러면 범위 밖 offset이 빈 화면을 만든다
  };

  const exportCsv = () =>
    downloadCsv(
      `subjects-${appCode}-${status}.csv`,
      ['가입', '최근 접속', '상태', '이메일', '로그인', '문의 수', '구독'],
      rows.map((r) => [
        r.createdAt,
        r.lastSeenAt ?? '',
        r.deletedAt ? '탈퇴' : '정상',
        r.email ?? '',
        r.provider,
        r.ticketCount,
        r.entitlement?.active ? `${r.entitlement.key} ~ ${r.entitlement.expiresAt ?? ''}` : '',
      ]),
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          value={status}
          onChange={pick}
          options={[
            ['all', '전체'],
            ['active', '활성'],
            ['inactive', '비활성'],
            ['withdrawn', '탈퇴'],
          ]}
        />
        <span className="text-[12px] text-fg-muted">
          {total.toLocaleString()}명 · 활성 기준 최근 {activeDays}일 접속
        </span>
        <div className="ml-auto">
          <CsvButton onClick={exportCsv} />
        </div>
      </div>

      {loading ? (
        <div className={card}>
          <EmptyState icon={Loader2}>불러오는 중…</EmptyState>
        </div>
      ) : rows.length ? (
        <div className={card}>
          <TableScroll>
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-border">
                  <th className={th}>상태</th>
                  <th className={`${th} w-full`}>계정</th>
                  <th className={th}>로그인</th>
                  <th className={th}>구독</th>
                  <th className={th}>문의</th>
                  <th className={th}>최근 접속</th>
                  <th className={th}>가입</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const stale =
                    !r.lastSeenAt || Date.now() - new Date(r.lastSeenAt).getTime() > activeDays * 86400_000;
                  return (
                    <tr key={r.id} className="border-b border-border last:border-0">
                      <td className={td}>
                        {r.deletedAt ? (
                          <Badge tone="danger">탈퇴</Badge>
                        ) : stale ? (
                          <Badge>비활성</Badge>
                        ) : (
                          <Badge tone="ok">활성</Badge>
                        )}
                      </td>
                      {/* 이메일이 없어도 행을 **구분할 수는** 있어야 한다 — uuid 앞 8자로 폴백 */}
                      <td className="px-4 py-3 text-[13px]" title={r.id}>
                        <div className="max-w-56 truncate">{subjectLabel(r.email, r.id)}</div>
                      </td>
                      <td className={`${td} text-fg-muted`}>{r.provider}</td>
                      <td className={td}>
                        {r.entitlement?.active ? (
                          <span className="text-ok" title={`~ ${fmt(r.entitlement.expiresAt)}`}>
                            {r.entitlement.key}
                          </span>
                        ) : (
                          <span className="text-fg-muted">—</span>
                        )}
                      </td>
                      <td className={`${td} text-fg-muted`}>{r.ticketCount || '—'}</td>
                      <td className={`${td} text-fg-muted`} title={fmt(r.lastSeenAt)}>
                        {ago(r.lastSeenAt)}
                      </td>
                      <td className={`${td} text-fg-muted`}>{fmt(r.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableScroll>
          <Pager offset={offset} limit={SUBJ_LIMIT} total={total} onMove={setOffset} />
        </div>
      ) : (
        <div className={card}>
          <EmptyState icon={Users}>
            {status === 'all'
              ? '아직 로그인한 사용자가 없습니다. 익명 문의만 받는 앱이면 정상입니다.'
              : '해당 상태의 사용자가 없습니다.'}
          </EmptyState>
        </div>
      )}
    </div>
  );
}

// ───────────────────────── 오류 · 웹훅 감사 ─────────────────────────

/** 반영되지 않은 웹훅을 사유별로 모아 본다.
 *  "결제가 안 붙었다"가 **웹훅 미수신**인지 **수신 후 거부**인지는 이 화면에서만 갈린다. */
function Errors({ stats }: { stats: Stats | null }) {
  if (!stats) {
    return (
      <div className={card}>
        <EmptyState icon={Loader2}>불러오는 중…</EmptyState>
      </div>
    );
  }
  const { byReason, recent, rejected24h } = stats.errors;
  const total = byReason.reduce((a, b) => a + b.n, 0);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          icon={OctagonAlert}
          label="거부 (최근 24h)"
          value={rejected24h}
          tone={rejected24h ? 'danger' : 'ok'}
          sub={rejected24h ? '그만큼 결제가 권한에 안 붙었습니다' : '정상'}
        />
        <Stat icon={Inbox} label="반영 안 된 이벤트(누적)" value={total} sub="거부 + 무시" />
        <Stat
          icon={KeyRound}
          label="웹훅 시크릿"
          value={stats.infra.rcWebhook ? '설정됨' : '미설정'}
          tone={stats.infra.rcWebhook ? 'ok' : 'danger'}
          sub={stats.infra.rcWebhook ? undefined : '미설정이면 모든 웹훅이 401로 거부됩니다'}
        />
      </div>

      <section className={card}>
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3.5">
          <h2 className={sectionTitle}>사유별</h2>
          {byReason.length > 0 && (
            <div className="ml-auto">
              <CsvButton
                onClick={() =>
                  downloadCsv(
                    'webhook-errors-byreason.csv',
                    ['판정', '사유', '건수'],
                    byReason.map((b) => [b.outcome, b.reason ?? '', b.n]),
                  )
                }
              />
            </div>
          )}
        </div>
        {byReason.length ? (
          <TableScroll>
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-border">
                  <th className={th}>판정</th>
                  <th className={`${th} w-full`}>사유</th>
                  <th className={th}>건수</th>
                </tr>
              </thead>
              <tbody>
                {byReason.map((b, i) => {
                  const o = OUTCOME[b.outcome] ?? { ko: b.outcome, tone: 'muted' as const };
                  return (
                    <tr key={i} className="border-b border-border last:border-0">
                      <td className={td}>
                        <Badge tone={o.tone}>{o.ko}</Badge>
                      </td>
                      <td className="px-4 py-3 font-mono text-[12.5px]">{b.reason ?? '—'}</td>
                      <td className={`${td} font-semibold`}>{b.n.toLocaleString()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableScroll>
        ) : (
          <EmptyState icon={ShieldCheck}>반영되지 않은 웹훅이 없습니다.</EmptyState>
        )}
      </section>

      <section className={card}>
        <div className="border-b border-border px-5 py-3.5">
          <h2 className={sectionTitle}>최근 {recent.length}건</h2>
          <p className="mt-1 text-[12px] text-fg-muted">
            무시(ignored)는 정상일 수 있습니다 — 샌드박스 결제·미해석 주체 등. 거부(rejected)는 인증·검증 실패입니다.
          </p>
        </div>
        {recent.length ? (
          <ul className="divide-y divide-border">
            {recent.map((e) => {
              const o = OUTCOME[e.outcome] ?? { ko: e.outcome, tone: 'muted' as const };
              return (
                <li key={e.id} className="flex flex-wrap items-center gap-2 px-5 py-2.5">
                  <Badge tone={o.tone}>{o.ko}</Badge>
                  <span className="font-mono text-[12px]">{e.type}</span>
                  {e.reason && <span className="text-[12px] text-warn">{e.reason}</span>}
                  {e.environment === 'SANDBOX' && <Badge tone="warn">샌드박스</Badge>}
                  <span className="truncate text-[12px] text-fg-muted">{e.productId ?? '—'}</span>
                  <span className="ml-auto shrink-0 text-[12px] text-fg-muted" title={fmt(e.createdAt)}>
                    {ago(e.createdAt)}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState icon={ShieldCheck}>기록이 없습니다.</EmptyState>
        )}
      </section>
    </div>
  );
}

// ───────────────────────── 구독 ─────────────────────────

type Subscriber = {
  subjectId: string;
  key: string;
  email: string | null;
  active: boolean;
  expiresAt: string | null;
  willRenew: boolean;
  inGracePeriod: boolean;
  productId: string | null;
  environment: string;
};
type PurchaseEvent = {
  id: string;
  type: string;
  outcome: string;
  reason: string | null;
  appUserId: string | null;
  productId: string | null;
  entitlementKey: string | null;
  environment: string | null;
  eventAt: string | null;
  /** 이 이벤트가 만들어낸 만료 시각. 없으면 만료를 안 건드린 이벤트(해지 예약·환불 등). */
  expiresAt: string | null;
  createdAt: string;
};
type BillingData = {
  configured: boolean;
  entitlementKeys: string;
  sandboxGrant: boolean;
  activeCount: number;
  subscribers: Subscriber[];
  events: PurchaseEvent[];
};

function Billing({ api, appCode, onError, flash }: Omit<Common, 'reload'> & { appCode: string }) {
  const [data, setData] = useState<BillingData | null>(null);
  const [busy, setBusy] = useState(false);
  // 생성된 시크릿은 **이 화면에서만** 존재한다(서버는 해시만 저장). 붙여넣기 전에 이탈하면 재발급해야 한다.
  const [fresh, setFresh] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await api(`billing?app=${appCode}`));
    } catch (e) {
      onError(String((e as Error).message));
    }
  }, [api, appCode, onError]);

  useEffect(() => {
    setFresh('');
    void load();
  }, [load]);

  const generate = async () => {
    if (data?.configured && !confirm('기존 시크릿이 즉시 무효가 됩니다.\nRC 대시보드에 새 값을 넣기 전까지 웹훅이 전부 거부됩니다.\n\n계속할까요?')) return;
    setBusy(true);
    try {
      const j = await api('billing', { method: 'PUT', body: JSON.stringify({ appCode, generate: true }) });
      setFresh(j.secret);
      onError('');
      await load();
      flash('시크릿을 발급했습니다');
    } catch (e) {
      onError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <EmptyState icon={Loader2}>불러오는 중…</EmptyState>;

  const hookUrl = `${typeof window === 'undefined' ? '' : window.location.origin}/api/webhooks/revenuecat/${appCode}`;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat icon={CreditCard} label="활성 구독" value={data.activeCount} tone={data.activeCount ? 'ok' : 'muted'} />
        <Stat
          icon={KeyRound}
          label="웹훅"
          value={data.configured ? '연결됨' : '미설정'}
          tone={data.configured ? 'ok' : 'danger'}
          sub={data.configured ? undefined : '시크릿이 없으면 모든 웹훅이 401로 거부됩니다'}
        />
        <Stat
          icon={AlertTriangle}
          label="샌드박스 지급"
          value={data.sandboxGrant ? 'ON' : 'OFF'}
          tone={data.sandboxGrant ? 'warn' : 'muted'}
          sub={data.sandboxGrant ? '테스트 결제가 실제 권한을 만듭니다 — 출시 전 끄세요' : '테스트 결제는 무시됩니다'}
        />
      </div>

      <section className={`${card} p-6`}>
        <h2 className={`mb-4 ${sectionTitle}`}>RevenueCat 웹훅</h2>

        <Field label="URL" hint="RC 대시보드 → Integrations → Webhooks 에 넣습니다.">
          <input readOnly value={hookUrl} className={`${input} font-mono text-[12px]`} onFocus={(e) => e.target.select()} />
        </Field>

        <div className="mt-4">
          <Field
            label="Authorization 시크릿"
            hint="서버는 sha256만 저장합니다 — 원문은 아래에서 한 번만 보입니다. 다시 볼 수 없으니 바로 RC에 붙여넣으세요."
          >
            <div className="flex flex-wrap gap-2">
              <Button variant={data.configured ? 'default' : 'primary'} onClick={generate} disabled={busy}>
                <KeyRound className="size-4" /> {data.configured ? '재발급' : '발급'}
              </Button>
              {data.configured && <span className="self-center text-[12px] text-ok">설정됨</span>}
            </div>
          </Field>
        </div>

        {fresh && (
          <div className="mt-3 rounded-lg border border-accent bg-accent-soft p-3">
            <p className="mb-2 text-[12px] font-semibold text-accent">지금 복사하세요 — 이 값은 다시 표시되지 않습니다</p>
            <input readOnly value={fresh} className={`${input} font-mono text-[12px]`} onFocus={(e) => e.target.select()} />
          </div>
        )}

        <p className="mt-4 text-[12px] text-fg-muted">
          허용 키: <code className="font-mono">{data.entitlementKeys}</code> — RC가 보낸 다른 키는 거부되고 아래 이력에 남습니다.
        </p>
      </section>

      <section className={card}>
        <div className="border-b border-border px-5 py-3.5">
          <h2 className={sectionTitle}>구독자 {data.subscribers.length ? `(${data.subscribers.length})` : ''}</h2>
        </div>
        {data.subscribers.length ? (
          <ul className="divide-y divide-border">
            {data.subscribers.map((s) => (
              <li key={`${s.subjectId}:${s.key}`} className="flex flex-wrap items-center gap-2 px-5 py-3">
                <Badge tone={s.active ? 'ok' : 'muted'}>{s.active ? '활성' : '만료'}</Badge>
                {s.inGracePeriod && <Badge tone="warn">결제 유예</Badge>}
                {!s.willRenew && s.active && <Badge tone="warn">해지 예약</Badge>}
                {s.environment === 'SANDBOX' && <Badge tone="warn">샌드박스</Badge>}
                <span className="truncate text-[13.5px]">{s.email ?? <span className="text-fg-muted">이메일 없음</span>}</span>
                <span className="text-[12px] text-fg-muted">{s.productId ?? '—'}</span>
                <span className="ml-auto text-[12px] text-fg-muted">~ {fmt(s.expiresAt)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon={CreditCard}>아직 구독자가 없습니다. 결제가 있었는데 비어 있다면 “오류” 탭에서 거부·무시된 웹훅을 확인하세요.</EmptyState>
        )}
      </section>

      <section className={card}>
        <div className="border-b border-border px-5 py-3.5">
          <h2 className={sectionTitle}>웹훅 이력</h2>
          {/* 무시·거부도 남는다. 안 남기면 "결제가 안 붙었다"가 웹훅 미수신인지 수신 후 무시인지 구분되지 않는다 */}
          <p className="mt-1 text-[12px] text-fg-muted">반영되지 않은 이벤트도 사유와 함께 남습니다. → 뒤는 그 이벤트가 만든 만료 시각입니다.</p>
        </div>
        {data.events.length ? (
          <ul className="divide-y divide-border">
            {data.events.map((e) => {
              const o = OUTCOME[e.outcome] ?? { ko: e.outcome, tone: 'muted' as const };
              return (
                <li key={e.id} className="flex flex-wrap items-center gap-2 px-5 py-2.5">
                  <Badge tone={o.tone}>{o.ko}</Badge>
                  <span className="font-mono text-[12px]">{e.type}</span>
                  {e.reason && <span className="text-[12px] text-warn">{e.reason}</span>}
                  <span className="truncate text-[12px] text-fg-muted">{e.productId ?? '—'}</span>
                  {/* "만료가 왜 이 값이 됐나"를 사후에 못 가른 적이 있다(2026-08-19). 결과를 그 자리에 둔다. */}
                  {e.expiresAt && <span className="shrink-0 font-mono text-[12px] text-fg-muted">→ {fmt(e.expiresAt)}</span>}
                  <span className="ml-auto shrink-0 text-[12px] text-fg-muted">{fmt(e.createdAt)}</span>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState icon={Inbox}>수신된 웹훅이 없습니다. 위 URL을 RC 대시보드에 등록했는지 확인하세요.</EmptyState>
        )}
      </section>
    </div>
  );
}

// ───────────────────────── 앱 설정 ─────────────────────────

function SettingsTab({ api, appCode, s, reload, onError, flash }: Common & { appCode: string; s: Settings | null }) {
  if (!s) return <EmptyState icon={Loader2}>불러오는 중…</EmptyState>;

  const save = async (patch: Partial<Settings>) => {
    // 점검·강제업데이트는 전 사용자의 진입을 즉시 막는다 — 켤 때만 확인을 받는다.
    if (patch.maintenance === true && !confirm('점검 모드를 켜면 이 앱의 모든 사용자가 즉시 진입할 수 없습니다.\n\n계속할까요?')) return;
    if (patch.minVersion && !confirm(`minVersion = ${patch.minVersion}\n\n이 버전 미만 사용자는 즉시 진입이 차단됩니다.\n계속할까요?`)) return;
    try {
      await api('settings', { method: 'PATCH', body: JSON.stringify({ appCode, ...patch }) });
      await reload();
      onError('');
      flash('저장했습니다');
    } catch (e) {
      onError(String((e as Error).message));
    }
  };

  const textField = (key: keyof Settings, label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <input
        defaultValue={(s[key] as string | null) ?? ''}
        className={input}
        onBlur={(e) => {
          if (e.target.value !== ((s[key] as string | null) ?? '')) void save({ [key]: e.target.value } as Partial<Settings>);
        }}
      />
    </Field>
  );

  return (
    <div className="max-w-2xl space-y-4">
      <section className={`${card} space-y-4 p-5`}>
        <h2 className={sectionTitle}>버전 게이트</h2>
        {textField('minVersion', '최소 버전', '이 미만은 진입 차단 (강제 업데이트)')}
        {textField('latestVersion', '최신 버전', '이 미만은 건너뛸 수 있는 안내')}
        {textField('androidStoreUrl', 'Android 스토어 URL')}
        {textField('iosStoreUrl', 'iOS 스토어 URL')}
        <p className="text-[12px] text-fg-muted">비우면 해당 게이트가 없는 것으로 처리됩니다. 저장 즉시 앱에 반영됩니다.</p>
      </section>

      <AuthProviders api={api} appCode={appCode} onError={onError} flash={flash} />

      {/* 위험 구역 — 진입 차단 스위치라 시각적으로 분리한다 */}
      <section className={`rounded-card border p-5 ${s.maintenance ? 'border-danger/40 bg-danger-soft' : 'border-danger/25 bg-surface'}`}>
        <div className="mb-4 flex items-start gap-3">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
          <div className="flex-1">
            <h2 className={`${sectionTitle} text-danger`}>점검 모드</h2>
            <p className="mt-0.5 text-xs text-fg-muted">
              켜는 즉시 이 앱의 <strong>모든 사용자</strong>가 진입할 수 없습니다.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={s.maintenance}
            onClick={() => save({ maintenance: !s.maintenance })}
            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
              s.maintenance ? 'bg-danger' : 'border border-border bg-muted'
            }`}
          >
            <span
              className={`absolute top-0.5 size-5 rounded-full bg-surface shadow transition-all ${
                s.maintenance ? 'left-[1.375rem]' : 'left-0.5'
              }`}
            />
          </button>
        </div>

        {s.maintenance && (
          <p className="mb-4 rounded-lg bg-danger/10 px-3 py-2 text-sm font-medium text-danger">
            현재 전 사용자 진입 차단 중입니다.
          </p>
        )}

        <div className="space-y-3">
          <Field label="점검 화면 제목">
            <input
              defaultValue={s.maintenanceTitle ?? ''}
              className={input}
              onBlur={(e) => e.target.value !== (s.maintenanceTitle ?? '') && save({ maintenanceTitle: e.target.value })}
            />
          </Field>
          <Field label="점검 화면 내용">
            <textarea
              defaultValue={s.maintenanceBody ?? ''}
              className={`${textarea} min-h-20 resize-y`}
              onBlur={(e) => e.target.value !== (s.maintenanceBody ?? '') && save({ maintenanceBody: e.target.value })}
            />
          </Field>
        </div>
      </section>
    </div>
  );
}

// ───────────────────────── 소셜 로그인 설정 ─────────────────────────

/**
 * 앱별 공급자 audience(클라이언트 ID) 등록.
 *
 * 서버가 **구현된 검증기가 있는 공급자만** 목록으로 내려준다(supported). 카카오·애플은 검증기를 붙이기
 * 전까지 여기 나타나지 않는다 — 미리 설정해두면 "켰는데 왜 로그인이 안 되지"로 시간을 버린다.
 */
function AuthProviders({ api, appCode, onError, flash }: Omit<Common, 'reload'> & { appCode: string }) {
  const [rows, setRows] = useState<AuthProvider[]>([]);
  const [supported, setSupported] = useState<string[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const j = await api(`auth-providers?app=${appCode}`);
      setRows(j.providers);
      setSupported(j.supported);
      setDraft({});
    } catch (e) {
      onError(String((e as Error).message));
    }
  }, [api, appCode, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const valueOf = (p: string) => draft[p] ?? rows.find((r) => r.provider === p)?.audiences ?? '';
  const savedOf = (p: string) => rows.find((r) => r.provider === p)?.audiences ?? '';

  const save = async (provider: string) => {
    try {
      await api('auth-providers', { method: 'PUT', body: JSON.stringify({ appCode, provider, audiences: valueOf(provider) }) });
      await load();
      flash('로그인 설정을 저장했습니다');
    } catch (e) {
      onError(String((e as Error).message));
    }
  };

  const toggle = async (provider: string, enabled: boolean) => {
    try {
      await api('auth-providers', { method: 'PUT', body: JSON.stringify({ appCode, provider, audiences: savedOf(provider), enabled }) });
      await load();
      flash(enabled ? '로그인을 켰습니다' : '로그인을 껐습니다');
    } catch (e) {
      onError(String((e as Error).message));
    }
  };

  return (
    <section className={`${card} space-y-4 p-6`}>
      <div className="flex items-center gap-2">
        <Lock className="size-3.5 text-fg-muted" />
        <h2 className={sectionTitle}>소셜 로그인</h2>
      </div>

      {supported.map((p) => {
        const row = rows.find((r) => r.provider === p);
        const changed = valueOf(p) !== savedOf(p);
        return (
          <div key={p} className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium capitalize">{p}</span>
              {row ? (
                row.enabled ? (
                  <Badge tone="ok">사용</Badge>
                ) : (
                  <Badge>꺼짐</Badge>
                )
              ) : (
                <Badge tone="warn">미설정</Badge>
              )}
              {row && (
                <button
                  className="ml-auto text-[12px] text-fg-muted underline-offset-2 hover:underline"
                  onClick={() => toggle(p, !row.enabled)}
                >
                  {row.enabled ? '끄기' : '켜기'}
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <input
                value={valueOf(p)}
                onChange={(e) => setDraft((d) => ({ ...d, [p]: e.target.value }))}
                placeholder="클라이언트 ID (콤마로 여러 개)"
                className={`${input} min-w-60 flex-1 font-mono text-[12px]`}
              />
              <Button variant={changed ? 'primary' : 'default'} disabled={!changed} onClick={() => save(p)}>
                저장
              </Button>
            </div>
          </div>
        );
      })}

      <p className="text-[12px] leading-relaxed text-fg-muted">
        구글은 <strong>웹 클라이언트 ID</strong>를 반드시 포함하세요 — 안드로이드·iOS 네이티브 로그인도 idToken은 웹
        클라이언트 ID로 발급됩니다. 빠뜨리면 “설정은 다 했는데 로그인만 안 되는” 상태가 됩니다. 클라이언트 ID는 앱
        번들에 박히는 공개값이라 여기 저장해도 안전합니다.
      </p>
    </section>
  );
}

// ───────────────────────── 앱 관리 ─────────────────────────

function AppsTab({ api, apps, reload, onError, flash }: Common & { apps: App[] }) {
  const [form, setForm] = useState({ appCode: '', name: '' });

  const create = async () => {
    if (!/^[a-z0-9_]{2,64}$/.test(form.appCode)) return onError('app_code는 소문자·숫자·밑줄 2~64자입니다');
    if (!form.name.trim()) return onError('앱 이름을 입력하세요');
    try {
      await api('apps', { method: 'POST', body: JSON.stringify(form) });
      setForm({ appCode: '', name: '' });
      onError('');
      await reload();
      flash('앱을 등록했습니다');
    } catch (e) {
      onError(String((e as Error).message));
    }
  };

  const patch = async (appCode: string, body: Record<string, unknown>, msg: string) => {
    try {
      await api('apps', { method: 'PATCH', body: JSON.stringify({ appCode, ...body }) });
      await reload();
      flash(msg);
    } catch (e) {
      onError(String((e as Error).message));
    }
  };

  return (
    <div className="space-y-4">
      <section className={`${card} p-6`}>
        <h2 className={`mb-4 ${sectionTitle}`}>앱 등록</h2>
        <div className="flex flex-wrap gap-2">
          <input
            placeholder="app_code (예: myword)"
            value={form.appCode}
            onChange={(e) => setForm({ ...form, appCode: e.target.value })}
            className={`${input} min-w-44 flex-1`}
          />
          <input
            placeholder="표시 이름"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className={`${input} min-w-44 flex-1`}
          />
          <Button variant="primary" onClick={create}>
            <Plus className="size-4" /> 등록
          </Button>
        </div>
        <p className="mt-3 text-xs text-fg-muted">
          app_code는 앱 번들과 디스코드 env 키(
          <code className="rounded bg-muted px-1 py-0.5">DISCORD_TICKET_WEBHOOK_URL_&lt;대문자&gt;</code>)에 박히므로 나중에 바꿀 수
          없습니다.
        </p>
      </section>

      {apps.map((a) => (
        <article key={a.appCode} className={`${card} flex flex-wrap items-center gap-4 p-5`}>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="font-medium">{a.name}</h3>
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs text-fg-muted">{a.appCode}</code>
              {a.active ? <Badge tone="ok">활성</Badge> : <Badge tone="danger">비활성</Badge>}
            </div>
            <p className="mt-1 text-xs text-fg-muted">비활성으로 두면 이 앱의 공개 API가 404를 돌려줍니다.</p>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <span className="text-fg-muted">24h 캡</span>
            <input
              type="number"
              defaultValue={a.ticketDailyCap}
              min={1}
              className="w-24 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm"
              onBlur={(e) =>
                Number(e.target.value) !== a.ticketDailyCap &&
                patch(a.appCode, { ticketDailyCap: Number(e.target.value) }, '캡을 변경했습니다')
              }
            />
          </label>

          <Button
            variant={a.active ? 'danger' : 'default'}
            onClick={() => patch(a.appCode, { active: !a.active }, a.active ? '비활성화했습니다' : '활성화했습니다')}
          >
            {a.active ? '비활성화' : '활성화'}
          </Button>
        </article>
      ))}
    </div>
  );
}
