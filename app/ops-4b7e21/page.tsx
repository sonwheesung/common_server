'use client';

// 관리자 콘솔 — 앱 선택 + 4탭(공지 · 문의 · 설정 · 앱).
//
// ⚠ 경로의 무작위 문자열은 **보안 장치가 아니다**. 실제 방어는 서버의 ADMIN_TOKEN fail-closed 검증이고,
//   경로는 크롤링·우연한 방문을 줄이는 부수 조치일 뿐이다.
// 토큰은 sessionStorage에만, 그것도 **서버에서 통한 뒤에만** 저장한다 — 탭을 닫으면 사라진다.

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  Boxes,
  Check,
  Inbox,
  Loader2,
  Lock,
  LogOut,
  Megaphone,
  MessageSquare,
  Pin,
  Plus,
  Settings2,
  Trash2,
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

type Tab = 'announcements' | 'tickets' | 'settings' | 'apps';

const TOKEN_KEY = 'cs_admin_token';
const CATEGORY_KO: Record<string, string> = { bug: '버그', suggestion: '건의', question: '질문', etc: '기타' };
const STATUS_KO: Record<string, string> = { open: '미처리', replied: '메모됨', resolved: '완료' };
const KIND_KO: Record<string, string> = { notice: '공지', event: '이벤트', update: '업데이트' };

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

// ───────────────────────── 프리미티브 ─────────────────────────

const card = 'rounded-card border border-border bg-surface';
const input =
  'w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm placeholder:text-fg-muted/60 transition-colors';

function Button({
  variant = 'default',
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'ghost' | 'danger' }) {
  const base =
    'inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap';
  const variants = {
    default: 'border border-border bg-surface hover:bg-muted',
    primary: 'bg-accent text-accent-fg hover:opacity-90',
    ghost: 'text-fg-muted hover:bg-muted hover:text-fg',
    danger: 'border border-danger/30 text-danger hover:bg-danger-soft',
  };
  return <button className={`${base} ${variants[variant]} ${className}`} {...props} />;
}

function Badge({ tone = 'muted', children }: { tone?: 'muted' | 'accent' | 'ok' | 'warn' | 'danger'; children: React.ReactNode }) {
  const tones = {
    muted: 'bg-muted text-fg-muted',
    accent: 'bg-accent-soft text-accent',
    ok: 'bg-ok/10 text-ok',
    warn: 'bg-warn/10 text-warn',
    danger: 'bg-danger-soft text-danger',
  };
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>
  );
}

function EmptyState({ icon: Icon, children }: { icon: React.ElementType; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <Icon className="size-8 text-fg-muted/40" strokeWidth={1.5} />
      <p className="text-sm text-fg-muted">{children}</p>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium">{label}</span>
      {hint && <span className="mb-1.5 block text-xs text-fg-muted">{hint}</span>}
      {children}
    </label>
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
  const [apps, setApps] = useState<App[]>([]);
  const [appCode, setAppCode] = useState('');
  const [tab, setTab] = useState<Tab>('announcements');
  const [err, setErr] = useState('');

  useEffect(() => {
    setToken(sessionStorage.getItem(TOKEN_KEY) ?? '');
    setReady(true);
  }, []);

  /** 관리자 API 호출. 401이면 토큰을 버리고 즉시 입장 화면으로 되돌린다
   *  — 모든 탭이 이 함수를 거치므로, 세션 도중 토큰이 바뀌어도(회전·폐기) 한 곳에서 처리된다. */
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
      setAppCode((prev) => prev || j.apps[0]?.appCode || '');
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

  if (!ready) return null;

  // ── 입장 ──
  if (!verified) {
    return (
      <main className="grid min-h-dvh place-items-center p-6">
        <div className={`${card} w-full max-w-sm p-8`}>
          <div className="mb-6 flex flex-col items-center gap-3 text-center">
            <div className="grid size-11 place-items-center rounded-xl bg-accent-soft">
              <Lock className="size-5 text-accent" strokeWidth={2} />
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
              {checking ? <Loader2 className="size-4 animate-spin" /> : null}
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

  const TABS: [Tab, string, React.ElementType][] = [
    ['announcements', '공지', Megaphone],
    ['tickets', '문의', MessageSquare],
    ['settings', '설정', Settings2],
    ['apps', '앱', Boxes],
  ];

  const current = apps.find((a) => a.appCode === appCode);

  return (
    <div className="min-h-dvh">
      {/* 상단 바 — 스크롤해도 앱 선택과 로그아웃은 항상 보인다 */}
      <header className="sticky top-0 z-10 border-b border-border bg-bg/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-5">
          <Bell className="size-4 shrink-0 text-accent" />
          <span className="text-sm font-semibold tracking-tight">공통 서버</span>

          <span className="text-border">/</span>
          <select
            value={appCode}
            onChange={(e) => setAppCode(e.target.value)}
            className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm"
          >
            {apps.map((a) => (
              <option key={a.appCode} value={a.appCode}>
                {a.name}
              </option>
            ))}
          </select>
          {current && !current.active && <Badge tone="danger">비활성</Badge>}

          <Button
            variant="ghost"
            className="ml-auto"
            onClick={() => {
              sessionStorage.removeItem(TOKEN_KEY);
              setToken('');
              setVerified(false);
            }}
          >
            <LogOut className="size-4" /> 로그아웃
          </Button>
        </div>

        <nav className="mx-auto flex max-w-5xl gap-1 px-5">
          {TABS.map(([k, label, Icon]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm transition-colors ${
                tab === k
                  ? 'border-accent font-medium text-fg'
                  : 'border-transparent text-fg-muted hover:text-fg'
              }`}
            >
              <Icon className="size-4" /> {label}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-5xl px-5 py-6">
        {err && (
          <div className="mb-4 flex items-center gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
            <AlertTriangle className="size-4 shrink-0" /> {err}
          </div>
        )}

        {!appCode && tab !== 'apps' ? (
          <EmptyState icon={Boxes}>등록된 앱이 없습니다. “앱” 탭에서 먼저 등록하세요.</EmptyState>
        ) : tab === 'announcements' ? (
          <Announcements api={api} appCode={appCode} onError={setErr} />
        ) : tab === 'tickets' ? (
          <Tickets api={api} appCode={appCode} onError={setErr} />
        ) : tab === 'settings' ? (
          <SettingsTab api={api} appCode={appCode} onError={setErr} />
        ) : (
          <AppsTab api={api} apps={apps} reload={loadApps} onError={setErr} />
        )}
      </main>
    </div>
  );
}

type Api = (path: string, init?: RequestInit) => Promise<any>;
type TabProps = { api: Api; appCode: string; onError: (m: string) => void };

// ───────────────────────── 공지 ─────────────────────────

function Announcements({ api, appCode, onError }: TabProps) {
  const [rows, setRows] = useState<Announcement[]>([]);
  const [form, setForm] = useState({ kind: 'notice', title: '', body: '', pinned: false, startsAt: '', endsAt: '' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows((await api(`announcements?app=${appCode}`)).announcements);
    } catch (e) {
      onError(String((e as Error).message));
    }
  }, [api, appCode, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async () => {
    if (!form.title.trim() || !form.body.trim()) return onError('제목과 내용을 채우세요');
    setBusy(true);
    try {
      await api('announcements', { method: 'POST', body: JSON.stringify({ appCode, ...form }) });
      setForm({ kind: 'notice', title: '', body: '', pinned: false, startsAt: '', endsAt: '' });
      onError('');
      await load();
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
      await load();
    } catch (e) {
      onError(String((e as Error).message));
    }
  };

  const now = Date.now();

  return (
    <div className="space-y-4">
      {/* 발행 폼 */}
      <section className={`${card} p-5`}>
        <h2 className="mb-4 text-sm font-semibold">새 공지</h2>

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
              className={`${input} flex-1 min-w-60`}
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

      {/* 목록 */}
      {rows.map((a) => {
        const started = new Date(a.startsAt).getTime() <= now;
        const ended = a.endsAt ? new Date(a.endsAt).getTime() < now : false;
        return (
          <article key={a.id} className={`${card} p-5 ${ended ? 'opacity-60' : ''}`}>
            <div className="flex items-start justify-between gap-4">
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
                <h3 className="font-medium">{a.title}</h3>
                <p className="mt-2 whitespace-pre-wrap text-sm text-fg-muted">{a.body}</p>
                <p className="mt-3 text-xs text-fg-muted">
                  {fmt(a.startsAt)} ~ {a.endsAt ? fmt(a.endsAt) : '무기한'}
                </p>
              </div>
              <Button variant="danger" onClick={() => remove(a)}>
                <Trash2 className="size-4" />
              </Button>
            </div>
          </article>
        );
      })}

      {!rows.length && <EmptyState icon={Megaphone}>발행된 공지가 없습니다.</EmptyState>}
    </div>
  );
}

// ───────────────────────── 문의 ─────────────────────────

function Tickets({ api, appCode, onError }: TabProps) {
  const [rows, setRows] = useState<Ticket[]>([]);
  const [status, setStatus] = useState('');

  const load = useCallback(async () => {
    try {
      setRows((await api(`tickets?app=${appCode}${status ? `&status=${status}` : ''}`)).tickets);
    } catch (e) {
      onError(String((e as Error).message));
    }
  }, [api, appCode, status, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = async (id: string, body: Record<string, unknown>) => {
    try {
      await api('tickets', { method: 'PATCH', body: JSON.stringify({ id, ...body }) });
      await load();
    } catch (e) {
      onError(String((e as Error).message));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="rounded-lg border border-border bg-surface px-3 py-2 text-sm"
        >
          <option value="">전체</option>
          <option value="open">미처리</option>
          <option value="replied">메모됨</option>
          <option value="resolved">완료</option>
        </select>
        <p className="text-xs text-fg-muted">
          익명 단방향 접수입니다 — 메모는 내부용이고 사용자에게 전달되지 않습니다.
        </p>
      </div>

      {rows.map((t) => (
        <article key={t.id} className={`${card} p-5`}>
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

          <p className="whitespace-pre-wrap text-sm">{t.content}</p>

          <div className="mt-4 flex flex-wrap gap-2">
            <input
              placeholder="내부 메모 (Enter로 저장)"
              defaultValue={t.reply ?? ''}
              className={`${input} flex-1 min-w-60`}
              maxLength={4000}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void patch(t.id, { reply: (e.target as HTMLInputElement).value });
              }}
            />
            {t.status !== 'resolved' && (
              <Button onClick={() => patch(t.id, { status: 'resolved' })}>
                <Check className="size-4" /> 완료 처리
              </Button>
            )}
          </div>
        </article>
      ))}

      {!rows.length && <EmptyState icon={Inbox}>문의가 없습니다.</EmptyState>}
    </div>
  );
}

// ───────────────────────── 설정 ─────────────────────────

function SettingsTab({ api, appCode, onError }: TabProps) {
  const [s, setS] = useState<Settings | null>(null);

  const load = useCallback(async () => {
    try {
      setS((await api(`settings?app=${appCode}`)).settings);
    } catch (e) {
      onError(String((e as Error).message));
    }
  }, [api, appCode, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!s) return <EmptyState icon={Loader2}>불러오는 중…</EmptyState>;

  const save = async (patch: Partial<Settings>) => {
    // 점검·강제업데이트는 전 사용자의 진입을 즉시 막는다 — 켤 때만 확인을 받는다.
    if (patch.maintenance === true && !confirm('점검 모드를 켜면 이 앱의 모든 사용자가 즉시 진입할 수 없습니다.\n\n계속할까요?')) return;
    if (patch.minVersion && !confirm(`minVersion = ${patch.minVersion}\n\n이 버전 미만 사용자는 즉시 진입이 차단됩니다.\n계속할까요?`)) return;
    try {
      const j = await api('settings', { method: 'PATCH', body: JSON.stringify({ appCode, ...patch }) });
      setS(j.settings);
      onError('');
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
        <h2 className="text-sm font-semibold">버전</h2>
        {textField('minVersion', '최소 버전', '이 미만은 진입 차단 (강제 업데이트)')}
        {textField('latestVersion', '최신 버전', '이 미만은 건너뛸 수 있는 안내')}
        {textField('androidStoreUrl', 'Android 스토어 URL')}
        {textField('iosStoreUrl', 'iOS 스토어 URL')}
        <p className="text-xs text-fg-muted">
          비우면 해당 게이트가 없는 것으로 처리됩니다. 값 변경은 저장 즉시 앱에 반영됩니다.
        </p>
      </section>

      {/* 위험 구역 — 진입 차단 스위치라 시각적으로 분리한다 */}
      <section className={`rounded-card border p-5 ${s.maintenance ? 'border-danger/40 bg-danger-soft' : 'border-danger/25 bg-surface'}`}>
        <div className="mb-4 flex items-start gap-3">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
          <div className="flex-1">
            <h2 className="text-sm font-semibold text-danger">점검 모드</h2>
            <p className="mt-0.5 text-xs text-fg-muted">
              켜는 즉시 이 앱의 <strong>모든 사용자</strong>가 진입할 수 없습니다.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={s.maintenance}
            onClick={() => save({ maintenance: !s.maintenance })}
            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${s.maintenance ? 'bg-danger' : 'bg-muted border border-border'}`}
          >
            <span
              className={`absolute top-0.5 size-5 rounded-full bg-surface shadow transition-all ${s.maintenance ? 'left-[1.375rem]' : 'left-0.5'}`}
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

// ───────────────────────── 앱 ─────────────────────────

function AppsTab({
  api,
  apps,
  reload,
  onError,
}: {
  api: Api;
  apps: App[];
  reload: () => Promise<void>;
  onError: (m: string) => void;
}) {
  const [form, setForm] = useState({ appCode: '', name: '' });

  const create = async () => {
    if (!/^[a-z0-9_]{2,64}$/.test(form.appCode)) return onError('app_code는 소문자·숫자·밑줄 2~64자입니다');
    if (!form.name.trim()) return onError('앱 이름을 입력하세요');
    try {
      await api('apps', { method: 'POST', body: JSON.stringify(form) });
      setForm({ appCode: '', name: '' });
      onError('');
      await reload();
    } catch (e) {
      onError(String((e as Error).message));
    }
  };

  const patch = async (appCode: string, body: Record<string, unknown>) => {
    try {
      await api('apps', { method: 'PATCH', body: JSON.stringify({ appCode, ...body }) });
      await reload();
    } catch (e) {
      onError(String((e as Error).message));
    }
  };

  return (
    <div className="space-y-4">
      <section className={`${card} p-5`}>
        <h2 className="mb-4 text-sm font-semibold">앱 등록</h2>
        <div className="flex flex-wrap gap-2">
          <input
            placeholder="app_code (예: myword)"
            value={form.appCode}
            onChange={(e) => setForm({ ...form, appCode: e.target.value })}
            className={`${input} flex-1 min-w-44`}
          />
          <input
            placeholder="표시 이름"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className={`${input} flex-1 min-w-44`}
          />
          <Button variant="primary" onClick={create}>
            <Plus className="size-4" /> 등록
          </Button>
        </div>
        <p className="mt-3 text-xs text-fg-muted">
          app_code는 앱 번들과 디스코드 env 키(<code className="rounded bg-muted px-1 py-0.5">DISCORD_TICKET_WEBHOOK_URL_&lt;대문자&gt;</code>)에
          박히므로 나중에 바꿀 수 없습니다.
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
            <p className="mt-1 text-xs text-fg-muted">문의 24시간 캡 · {a.ticketDailyCap}건</p>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <span className="text-fg-muted">캡</span>
            <input
              type="number"
              defaultValue={a.ticketDailyCap}
              min={1}
              className="w-24 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm"
              onBlur={(e) =>
                Number(e.target.value) !== a.ticketDailyCap && patch(a.appCode, { ticketDailyCap: Number(e.target.value) })
              }
            />
          </label>

          <Button variant={a.active ? 'danger' : 'default'} onClick={() => patch(a.appCode, { active: !a.active })}>
            {a.active ? '비활성화' : '활성화'}
          </Button>
        </article>
      ))}
    </div>
  );
}
