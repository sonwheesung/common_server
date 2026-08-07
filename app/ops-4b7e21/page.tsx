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
  Inbox,
  LayoutDashboard,
  Loader2,
  Lock,
  LogOut,
  Megaphone,
  Menu,
  MessageSquare,
  Moon,
  Pencil,
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
  category: string;
  content: string;
  status: string;
  reply: string | null;
  platform: string | null;
  appVersion: string | null;
  createdAt: string;
};

type Tab = 'overview' | 'anns' | 'tickets' | 'settings' | 'apps';

const TOKEN_KEY = 'cs_admin_token';
const CATEGORY_KO: Record<string, string> = { bug: '버그', suggestion: '건의', question: '질문', etc: '기타' };
const STATUS_KO: Record<string, string> = { open: '미처리', replied: '메모됨', resolved: '완료' };
const KIND_KO: Record<string, string> = { notice: '공지', event: '이벤트', update: '업데이트' };

const NAV: { id: Tab; icon: React.ElementType; label: string; grp?: string }[] = [
  { id: 'overview', icon: LayoutDashboard, label: '대시보드' },
  { id: 'anns', icon: Megaphone, label: '공지', grp: '운영' },
  { id: 'tickets', icon: MessageSquare, label: '문의', grp: '운영' },
  { id: 'settings', icon: Wrench, label: '앱 설정', grp: '설정' },
  { id: 'apps', icon: Boxes, label: '앱 관리', grp: '설정' },
];
const TITLES: Record<Tab, string> = {
  overview: '대시보드',
  anns: '공지 관리',
  tickets: '문의',
  settings: '앱 설정',
  apps: '앱 관리',
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
const input =
  'w-full rounded-lg border border-border bg-surface px-3 py-2 text-[13.5px] placeholder:text-fg-muted/55 transition-colors focus:border-accent';
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

function Announcements({
  api,
  appCode,
  rows,
  reload,
  onError,
  flash,
}: Common & { appCode: string; rows: Announcement[] }) {
  const [form, setForm] = useState({ kind: 'notice', title: '', body: '', pinned: false, startsAt: '', endsAt: '' });
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!form.title.trim() || !form.body.trim()) return onError('제목과 내용을 채우세요');
    setBusy(true);
    try {
      await api('announcements', { method: 'POST', body: JSON.stringify({ appCode, ...form }) });
      setForm({ kind: 'notice', title: '', body: '', pinned: false, startsAt: '', endsAt: '' });
      onError('');
      await reload();
      flash('공지를 발행했습니다');
    } catch (e) {
      onError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (a: Announcement) => {
    if (!confirm(`"${a.title}"\n\n이 공지를 삭제할까요? 되돌릴 수 없습니다.`)) return;
    try {
      await api(`announcements?id=${a.id}`, { method: 'DELETE' });
      await reload();
      flash('삭제했습니다');
    } catch (e) {
      onError(String((e as Error).message));
    }
  };

  // ── 수정 ──
  // 서버는 처음부터 PATCH를 지원했는데 화면에 노출하지 않아 "고칠 수 없는 공지"가 됐다.
  // 오타 하나 때문에 지우고 다시 쓰면 id가 바뀌고, id는 앱의 읽음 처리 키라 **이미 읽은 사람에게도 다시 안읽음으로 뜬다.**
  // 그래서 수정은 삭제-재작성으로 대체할 수 없다.
  const [editing, setEditing] = useState<string | null>(null);
  const [edit, setEdit] = useState({ kind: 'notice', title: '', body: '', pinned: false, startsAt: '', endsAt: '' });

  const beginEdit = (a: Announcement) => {
    setEditing(a.id);
    setEdit({
      kind: a.kind,
      title: a.title,
      body: a.body,
      pinned: a.pinned,
      startsAt: toLocalInput(a.startsAt),
      endsAt: toLocalInput(a.endsAt),
    });
  };

  const saveEdit = async (id: string) => {
    if (!edit.title.trim() || !edit.body.trim()) return onError('제목과 내용을 채우세요');
    setBusy(true);
    try {
      // 폼 전체를 보낸다 — endsAt을 비우면 서버가 null(무기한)로 되돌린다.
      await api('announcements', { method: 'PATCH', body: JSON.stringify({ id, ...edit }) });
      setEditing(null);
      onError('');
      await reload();
      flash('수정했습니다');
    } catch (e) {
      onError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const now = Date.now();

  return (
    <div className="space-y-4">
      <section className={`${card} p-6`}>
        <h2 className={`mb-4 ${sectionTitle}`}>새 공지</h2>
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <select
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value })}
              className="rounded-lg border border-border bg-surface px-3 py-2 text-sm"
            >
              <option value="notice">공지</option>
              <option value="event">이벤트</option>
              <option value="update">업데이트</option>
            </select>
            <input
              placeholder="제목"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              className={`${input} min-w-60 flex-1`}
              maxLength={200}
            />
            <button
              type="button"
              onClick={() => setForm({ ...form, pinned: !form.pinned })}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm transition-colors ${
                form.pinned ? 'border-accent bg-accent-soft text-accent' : 'border-border text-fg-muted hover:bg-muted'
              }`}
            >
              <Pin className="size-4" /> 상단 고정
            </button>
          </div>

          <textarea
            placeholder="내용 (줄바꿈은 앱에서 그대로 보입니다)"
            value={form.body}
            onChange={(e) => setForm({ ...form, body: e.target.value })}
            className={`${input} min-h-28 resize-y`}
            maxLength={10000}
          />

          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-fg-muted">노출 기간</span>
            <input
              type="datetime-local"
              value={form.startsAt}
              onChange={(e) => setForm({ ...form, startsAt: e.target.value })}
              className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm"
            />
            <span className="text-fg-muted">~</span>
            <input
              type="datetime-local"
              value={form.endsAt}
              onChange={(e) => setForm({ ...form, endsAt: e.target.value })}
              className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm"
            />
            <span className="text-xs text-fg-muted">비우면 즉시 시작 · 무기한</span>
            <Button variant="primary" className="ml-auto" onClick={submit} disabled={busy}>
              <Plus className="size-4" /> 발행
            </Button>
          </div>
        </div>
      </section>

      {rows.map((a) => {
        const started = new Date(a.startsAt).getTime() <= now;
        const ended = a.endsAt ? new Date(a.endsAt).getTime() < now : false;

        if (editing === a.id) {
          return (
            <article key={a.id} className="rounded-card border-2 border-accent bg-surface p-5">
              <h2 className="mb-4 text-sm font-semibold text-accent">공지 수정</h2>
              <div className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  <select
                    value={edit.kind}
                    onChange={(e) => setEdit({ ...edit, kind: e.target.value })}
                    className="rounded-lg border border-border bg-surface px-3 py-2 text-sm"
                  >
                    <option value="notice">공지</option>
                    <option value="event">이벤트</option>
                    <option value="update">업데이트</option>
                  </select>
                  <input
                    value={edit.title}
                    onChange={(e) => setEdit({ ...edit, title: e.target.value })}
                    className={`${input} min-w-60 flex-1`}
                    maxLength={200}
                  />
                  <button
                    type="button"
                    onClick={() => setEdit({ ...edit, pinned: !edit.pinned })}
                    className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm transition-colors ${
                      edit.pinned ? 'border-accent bg-accent-soft text-accent' : 'border-border text-fg-muted hover:bg-muted'
                    }`}
                  >
                    <Pin className="size-4" /> 상단 고정
                  </button>
                </div>

                <textarea
                  value={edit.body}
                  onChange={(e) => setEdit({ ...edit, body: e.target.value })}
                  className={`${input} min-h-32 resize-y`}
                  maxLength={10000}
                />

                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-fg-muted">노출 기간</span>
                  <input
                    type="datetime-local"
                    value={edit.startsAt}
                    onChange={(e) => setEdit({ ...edit, startsAt: e.target.value })}
                    className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm"
                  />
                  <span className="text-fg-muted">~</span>
                  <input
                    type="datetime-local"
                    value={edit.endsAt}
                    onChange={(e) => setEdit({ ...edit, endsAt: e.target.value })}
                    className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm"
                  />
                  <span className="text-xs text-fg-muted">종료를 비우면 무기한</span>
                  <div className="ml-auto flex gap-2">
                    <Button onClick={() => setEditing(null)} disabled={busy}>
                      취소
                    </Button>
                    <Button variant="primary" onClick={() => saveEdit(a.id)} disabled={busy}>
                      <Check className="size-4" /> 저장
                    </Button>
                  </div>
                </div>
              </div>
            </article>
          );
        }

        return (
          <article key={a.id} className={`${card} p-6 ${ended ? 'opacity-60' : ''}`}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="mb-2 flex flex-wrap items-center gap-1.5">
                  {ended ? <Badge>종료</Badge> : started ? <Badge tone="ok">노출 중</Badge> : <Badge tone="warn">예정</Badge>}
                  {a.pinned && (
                    <Badge tone="accent">
                      <Pin className="mr-1 size-3" /> 고정
                    </Badge>
                  )}
                  <Badge>{KIND_KO[a.kind] ?? a.kind}</Badge>
                </div>
                <h3 className="text-[14.5px] font-semibold tracking-tight">{a.title}</h3>
                <p className="mt-2 whitespace-pre-wrap text-[13.5px] leading-relaxed text-fg-muted">{a.body}</p>
                <p className="mt-3 text-[12px] text-fg-muted">
                  {fmt(a.startsAt)} ~ {a.endsAt ? fmt(a.endsAt) : '무기한'}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button onClick={() => beginEdit(a)}>
                  <Pencil className="size-4" /> 수정
                </Button>
                <Button variant="danger" onClick={() => remove(a)}>
                  <Trash2 className="size-4" /> 삭제
                </Button>
              </div>
            </div>
          </article>
        );
      })}

      {!rows.length && <EmptyState icon={Megaphone}>발행된 공지가 없습니다.</EmptyState>}
    </div>
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
        <p className="text-xs text-fg-muted">익명 단방향 접수입니다 — 메모는 내부용이고 사용자에게 전달되지 않습니다.</p>
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
            <span className="text-xs text-fg-muted">
              {t.platform ?? '—'}
              {t.appVersion ? ` · v${t.appVersion}` : ''}
            </span>
            <span className="ml-auto text-xs text-fg-muted">{fmt(t.createdAt)}</span>
          </div>

          <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed">{t.content}</p>

          <div className="mt-4 flex flex-wrap gap-2">
            <input
              placeholder="내부 메모"
              value={memoOf(t)}
              onChange={(e) => setMemo((m) => ({ ...m, [t.id]: e.target.value }))}
              className={`${input} min-w-60 flex-1`}
              maxLength={4000}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && dirty(t)) void patch(t.id, { reply: memoOf(t) }, '메모를 저장했습니다');
              }}
            />
            <Button
              variant={dirty(t) ? 'primary' : 'default'}
              onClick={() => patch(t.id, { reply: memoOf(t) }, '메모를 저장했습니다')}
              disabled={!dirty(t)}
            >
              <Check className="size-4" /> 메모 저장
            </Button>
            {t.status !== 'resolved' && (
              <Button onClick={() => patch(t.id, { status: 'resolved' }, '완료 처리했습니다')}>완료 처리</Button>
            )}
          </div>
          {dirty(t) && <p className="mt-2 text-xs text-warn">저장하지 않은 메모가 있습니다</p>}
        </article>
      ))}

      {!filtered.length && <EmptyState icon={Inbox}>{status ? '해당 상태의 문의가 없습니다.' : '문의가 없습니다.'}</EmptyState>}
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
        <p className="text-xs text-fg-muted">비우면 해당 게이트가 없는 것으로 처리됩니다. 저장 즉시 앱에 반영됩니다.</p>
      </section>

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
              className={`${input} min-h-20 resize-y`}
              onBlur={(e) => e.target.value !== (s.maintenanceBody ?? '') && save({ maintenanceBody: e.target.value })}
            />
          </Field>
        </div>
      </section>
    </div>
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
