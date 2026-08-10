'use client';

// 관리자 콘솔 — 좌측 사이드바 IA(배구 서버 ops 콘솔 참고).
//
// ⚠ 경로의 무작위 문자열은 **보안 장치가 아니다**. 실제 방어는 서버의 ADMIN_TOKEN fail-closed 검증이고,
//   경로는 크롤링·우연한 방문을 줄이는 부수 조치일 뿐이다.
// 토큰은 sessionStorage에만, 그것도 **서버에서 통한 뒤에만** 저장한다 — 탭을 닫으면 사라진다.
//
// 배구 콘솔과 다른 점: 저쪽은 PROJ_CODE 고정이라 앱 개념이 없지만 여기는 **1배포 N앱**이다.
// 그래서 앱 선택이 사이드바 최상단 일급 요소이고, URL에도 앱이 들어간다(?app=&tab=).
//
// 데이터는 **루트에서 한 번에** 불러 탭들에 내려준다. 탭마다 따로 부르면 미처리 문의 뱃지도
// 대시보드 요약도 만들 수 없다(각 탭이 자기 데이터만 알기 때문).

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Boxes,
  Check,
  ChevronLeft,
  CreditCard,
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
  Pin,
  Plus,
  RefreshCw,
  Server,
  Settings2,
  Sun,
  Trash2,
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
  platform: string | null;
  appVersion: string | null;
  createdAt: string;
};

type AuthProvider = { appCode: string; provider: string; audiences: string; enabled: boolean };

type Tab = 'overview' | 'anns' | 'tickets' | 'billing' | 'settings' | 'apps';

const TOKEN_KEY = 'cs_admin_token';
const CATEGORY_KO: Record<string, string> = { bug: '버그', suggestion: '건의', question: '질문', etc: '기타' };
const STATUS_KO: Record<string, string> = { open: '미처리', replied: '메모됨', resolved: '완료' };
const KIND_KO: Record<string, string> = { notice: '공지', event: '이벤트', update: '업데이트' };

const NAV: { id: Tab; icon: React.ElementType; label: string; grp?: string }[] = [
  { id: 'overview', icon: LayoutDashboard, label: '대시보드' },
  { id: 'anns', icon: Megaphone, label: '공지', grp: '운영' },
  { id: 'tickets', icon: MessageSquare, label: '문의', grp: '운영' },
  { id: 'billing', icon: CreditCard, label: '구독', grp: '운영' },
  { id: 'settings', icon: Wrench, label: '앱 설정', grp: '설정' },
  { id: 'apps', icon: Boxes, label: '앱 관리', grp: '설정' },
];
const TITLES: Record<Tab, string> = {
  overview: '대시보드',
  anns: '공지 관리',
  tickets: '문의',
  billing: '구독',
  settings: '앱 설정',
  apps: '앱 관리',
};

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
  const [booting, setBooting] = useState(true);
  const [toast, setToast] = useState('');

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
    setToken(sessionStorage.getItem(TOKEN_KEY) ?? '');
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
   *  — 모든 호출이 이 함수를 거치므로, 세션 도중 토큰이 바뀌어도(회전·폐기) 한 곳에서 처리된다. */
  const api = useCallback(
    async (path: string, init?: RequestInit) => {
      const res = await fetch(`/api/admin/${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
      });
      if (res.status === 401) {
        sessionStorage.removeItem(TOKEN_KEY);
        setToken('');
        setVerified(false);
        throw new Error('ADMIN_TOKEN이 맞지 않습니다');
      }
      const json = await res.json().catch(() => ({ ok: false, reason: 'parse-error' }));
      if (!res.ok || !json.ok) throw new Error(json.reason ?? 'error');
      return json;
    },
    [token],
  );

  /** 앱 목록 조회 = 토큰 검증을 겸한다(성공해야 콘솔에 들어간다). */
  const loadApps = useCallback(async () => {
    setChecking(true);
    try {
      const j = await api('apps');
      setApps(j.apps);
      setAppCode((prev) => (prev && j.apps.some((a: App) => a.appCode === prev) ? prev : (j.apps[0]?.appCode ?? '')));
      setErr('');
      sessionStorage.setItem(TOKEN_KEY, token); // 통한 토큰만 저장한다
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
      const [s, a, t] = await Promise.all([
        api(`settings?app=${appCode}`),
        api(`announcements?app=${appCode}`),
        api(`tickets?app=${appCode}`),
      ]);
      setSettings(s.settings);
      setAnns(a.announcements);
      setTickets(t.tickets);
      setErr('');
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBooting(false);
    }
  }, [api, appCode]);

  useEffect(() => {
    if (verified) void loadApp();
  }, [verified, loadApp]);

  const openTickets = useMemo(() => tickets.filter((t) => t.status === 'open').length, [tickets]);

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
              <h1 className="text-base font-semibold tracking-tight">관리자 콘솔</h1>
              <p className="mt-1 text-sm text-fg-muted">공통 서버</p>
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
          <p className="mt-6 text-center text-xs text-fg-muted">이 탭에서만 유지됩니다 · 닫으면 사라집니다</p>
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
        <div className="flex items-center gap-2 px-1">
          <div className="grid size-7 place-items-center rounded-lg bg-accent-soft">
            <Server className="size-3.5 text-accent" />
          </div>
          <span className="text-[14px] font-bold tracking-tight">공통 서버</span>
          <button className="ml-auto md:hidden" onClick={() => setNavOpen(false)} aria-label="메뉴 닫기">
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
              <button
                onClick={() => navigate({ tab: n.id })}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-[13.5px] transition-colors ${
                  tab === n.id
                    ? 'bg-accent-soft font-semibold text-accent'
                    : 'font-medium text-fg-muted hover:bg-muted hover:text-fg'
                }`}
              >
                <n.icon className="size-4 shrink-0" />
                {n.label}
                {n.id === 'tickets' && openTickets > 0 && (
                  <span className="ml-auto rounded-full bg-danger px-1.5 py-px text-[11px] font-bold text-white">
                    {openTickets}
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
              sessionStorage.removeItem(TOKEN_KEY);
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
          <Button
            variant="ghost"
            className="ml-auto"
            onClick={() => {
              void loadApps();
              void loadApp();
              flash('새로고침됨');
            }}
          >
            <RefreshCw className="size-4" /> 새로고침
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
              openTickets={openTickets}
              go={(t) => navigate({ tab: t })}
            />
          ) : tab === 'anns' ? (
            <Announcements api={api} appCode={appCode} rows={anns} reload={loadApp} onError={setErr} flash={flash} />
          ) : tab === 'tickets' ? (
            <Tickets api={api} rows={tickets} reload={loadApp} onError={setErr} flash={flash} />
          ) : tab === 'billing' ? (
            <Billing api={api} appCode={appCode} onError={setErr} flash={flash} />
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

function Overview({
  app,
  settings,
  anns,
  tickets,
  openTickets,
  go,
}: {
  app?: App;
  settings: Settings | null;
  anns: Announcement[];
  tickets: Ticket[];
  openTickets: number;
  go: (t: Tab) => void;
}) {
  const now = Date.now();
  const live = anns.filter(
    (a) => new Date(a.startsAt).getTime() <= now && (!a.endsAt || new Date(a.endsAt).getTime() >= now),
  ).length;
  // 24시간 접수량 — 앱별 캡에 얼마나 근접했는지가 곧 "정상 문의가 막힐 위험"이다
  const since = now - 24 * 60 * 60 * 1000;
  const last24 = tickets.filter((t) => new Date(t.createdAt).getTime() >= since).length;
  const cap = app?.ticketDailyCap ?? 0;
  const capTone = cap && last24 >= cap ? 'danger' : cap && last24 >= cap * 0.7 ? 'warn' : 'muted';

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          icon={MessageSquare}
          label="미처리 문의"
          value={openTickets}
          sub={openTickets ? '확인이 필요합니다' : '모두 처리됨'}
          tone={openTickets ? 'warn' : 'ok'}
        />
        <Stat icon={Megaphone} label="노출 중 공지" value={live} sub={`전체 ${anns.length}건`} />
        <Stat
          icon={Inbox}
          label="24시간 접수"
          value={`${last24} / ${cap}`}
          sub={capTone === 'danger' ? '캡 도달 — 신규 접수가 429로 막힙니다' : '앱별 일일 캡'}
          tone={capTone}
        />
        <Stat
          icon={Wrench}
          label="서비스 상태"
          value={settings?.maintenance ? '점검 중' : '정상'}
          sub={settings?.maintenance ? '전 사용자 진입 차단' : app?.active ? '앱 활성' : '앱 비활성'}
          tone={settings?.maintenance || !app?.active ? 'danger' : 'ok'}
        />
      </div>

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
                {t.status === 'open' ? <Badge tone="warn">미처리</Badge> : <Badge tone="ok">{STATUS_KO[t.status] ?? t.status}</Badge>}
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

function Tickets({ api, rows, reload, onError, flash }: Common & { rows: Ticket[] }) {
  const [status, setStatus] = useState('');
  const filtered = useMemo(() => (status ? rows.filter((t) => t.status === status) : rows), [rows, status]);

  // 편집 중인 메모. 입력을 제어값으로 들고 있어야 저장 버튼이 "바뀐 게 있는지"를 알 수 있다
  // (예전엔 defaultValue라 Enter 말고는 값을 꺼낼 방법이 없었다).
  // 저장에 성공하면 항목을 지워 서버 값(t.reply)으로 되돌아가게 한다.
  const [memo, setMemo] = useState<Record<string, string>>({});
  const memoOf = (t: Ticket) => memo[t.id] ?? t.reply ?? '';
  const dirty = (t: Ticket) => memoOf(t) !== (t.reply ?? '');

  const patch = async (id: string, body: Record<string, unknown>, msg: string) => {
    try {
      await api('tickets', { method: 'PATCH', body: JSON.stringify({ id, ...body }) });
      await reload();
      setMemo((m) => {
        const next = { ...m };
        delete next[id];
        return next;
      });
      flash(msg);
    } catch (e) {
      onError(String((e as Error).message));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-border bg-surface p-0.5">
          {(
            [
              ['', '전체'],
              ['open', '미처리'],
              ['replied', '메모됨'],
              ['resolved', '완료'],
            ] as [string, string][]
          ).map(([v, label]) => (
            <button
              key={v}
              onClick={() => setStatus(v)}
              className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                status === v ? 'bg-accent text-accent-fg font-medium' : 'text-fg-muted hover:text-fg'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="text-[12px] text-fg-muted">
          <strong className="text-accent">회원</strong> 문의는 답변이 앱에 노출되고,{' '}
          <strong>익명</strong> 문의는 전달 경로가 없어 메모만 남습니다.
        </p>
      </div>

      {filtered.map((t) => (
        <article key={t.id} className={`${card} p-6`}>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {t.status === 'open' ? (
              <Badge tone="warn">{STATUS_KO[t.status]}</Badge>
            ) : t.status === 'resolved' ? (
              <Badge tone="ok">{STATUS_KO[t.status]}</Badge>
            ) : (
              <Badge tone="accent">{STATUS_KO[t.status] ?? t.status}</Badge>
            )}
            <Badge>{CATEGORY_KO[t.category] ?? t.category}</Badge>
            {/* 작성자 — 답변이 사용자에게 보이는지 아닌지가 여기서 갈린다 */}
            {t.subjectId ? (
              <Badge tone="accent">{t.subjectDeleted ? '탈퇴한 회원' : (t.subjectEmail ?? '회원')}</Badge>
            ) : (
              <Badge>익명</Badge>
            )}
            <span className="text-[12px] text-fg-muted">
              {t.platform ?? '—'}
              {t.appVersion ? ` · v${t.appVersion}` : ''}
            </span>
            <span className="ml-auto text-[12px] text-fg-muted">{fmt(t.createdAt)}</span>
          </div>

          <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed">{t.content}</p>

          <div className="mt-4 flex flex-wrap gap-2">
            <input
              placeholder={t.subjectId ? '답변 — 사용자에게 그대로 보입니다' : '내부 메모 — 사용자에게 보이지 않습니다'}
              value={memoOf(t)}
              onChange={(e) => setMemo((m) => ({ ...m, [t.id]: e.target.value }))}
              className={`${input} min-w-60 flex-1 ${t.subjectId ? 'border-accent/50' : ''}`}
              maxLength={4000}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && dirty(t)) void patch(t.id, { reply: memoOf(t) }, '저장했습니다');
              }}
            />
            <Button
              variant={dirty(t) ? 'primary' : 'default'}
              onClick={() => patch(t.id, { reply: memoOf(t) }, '저장했습니다')}
              disabled={!dirty(t)}
            >
              <Check className="size-4" /> {t.subjectId ? '답변 저장' : '메모 저장'}
            </Button>
            {t.status !== 'resolved' && (
              <Button onClick={() => patch(t.id, { status: 'resolved' }, '완료 처리했습니다')}>완료 처리</Button>
            )}
          </div>
          {/* 같은 컬럼(reply)이지만 회원 문의에서는 사용자에게 노출된다 —
              운영자가 메모 쓰듯 답변을 쓰는 사고를 막으려면 입력 시점에 알려야 한다 */}
          {t.subjectId && !t.subjectDeleted && (
            <p className="mt-2 text-[12px] text-accent">
              회원 문의입니다. 여기 쓴 내용은 앱의 “내 문의 내역”에 그대로 노출됩니다.
            </p>
          )}
          {t.subjectDeleted && (
            <p className="mt-2 text-[12px] text-fg-muted">탈퇴한 회원입니다 — 답변을 써도 전달되지 않습니다.</p>
          )}
          {dirty(t) && <p className="mt-2 text-[12px] text-warn">저장하지 않은 내용이 있습니다</p>}
        </article>
      ))}

      {!filtered.length && <EmptyState icon={Inbox}>{status ? '해당 상태의 문의가 없습니다.' : '문의가 없습니다.'}</EmptyState>}
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
          <EmptyState icon={CreditCard}>아직 구독자가 없습니다.</EmptyState>
        )}
      </section>

      <section className={card}>
        <div className="border-b border-border px-5 py-3.5">
          <h2 className={sectionTitle}>웹훅 이력</h2>
          {/* 무시·거부도 남는다. 안 남기면 "결제가 안 붙었다"가 웹훅 미수신인지 수신 후 무시인지 구분되지 않는다 */}
          <p className="mt-1 text-[12px] text-fg-muted">반영되지 않은 이벤트도 사유와 함께 남습니다.</p>
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
                  <span className="ml-auto shrink-0 text-[12px] text-fg-muted">{fmt(e.createdAt)}</span>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState icon={Inbox}>수신된 웹훅이 없습니다.</EmptyState>
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
