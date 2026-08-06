'use client';

// 관리자 콘솔 — 앱 선택 + 4탭(공지 · 문의 · 설정 · 앱).
//
// ⚠ 경로의 무작위 문자열은 **보안 장치가 아니다**. 실제 방어는 서버의 ADMIN_TOKEN fail-closed 검증이고,
//   경로는 크롤링·우연한 방문을 줄이는 부수 조치일 뿐이다.
// 토큰은 sessionStorage에만 둔다 — 탭을 닫으면 사라져서 공용 PC에 남지 않는다.

import { useCallback, useEffect, useState } from 'react';

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

const S = {
  page: { padding: '24px 32px', maxWidth: 1100, margin: '0 auto', fontSize: 14, color: '#1a1a1a' },
  row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' as const },
  input: { padding: '7px 10px', border: '1px solid #d4d4d4', borderRadius: 6, fontSize: 14, fontFamily: 'inherit' },
  btn: { padding: '7px 14px', border: '1px solid #d4d4d4', borderRadius: 6, background: '#fff', cursor: 'pointer', fontSize: 14 },
  btnPrimary: { padding: '7px 14px', border: 0, borderRadius: 6, background: '#1a1a1a', color: '#fff', cursor: 'pointer', fontSize: 14 },
  card: { border: '1px solid #e6e6e6', borderRadius: 8, padding: 14, marginBottom: 10 },
  label: { display: 'block', fontSize: 12, color: '#666', marginBottom: 4 },
  muted: { color: '#888', fontSize: 13 },
};

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ko-KR') : '—');

export default function Ops() {
  const [token, setToken] = useState('');
  const [ready, setReady] = useState(false);
  const [apps, setApps] = useState<App[]>([]);
  const [appCode, setAppCode] = useState('');
  const [tab, setTab] = useState<Tab>('announcements');
  const [err, setErr] = useState('');

  useEffect(() => {
    setToken(sessionStorage.getItem(TOKEN_KEY) ?? '');
    setReady(true);
  }, []);

  /** 관리자 API 호출. 401이면 토큰 문제라는 걸 즉시 알린다(조용히 빈 목록을 보여주면 오해한다). */
  const api = useCallback(
    async (path: string, init?: RequestInit) => {
      const res = await fetch(`/api/admin/${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
      });
      const json = await res.json().catch(() => ({ ok: false, reason: 'parse-error' }));
      if (!res.ok || !json.ok) throw new Error(res.status === 401 ? 'ADMIN_TOKEN이 맞지 않습니다' : (json.reason ?? 'error'));
      return json;
    },
    [token],
  );

  const loadApps = useCallback(async () => {
    try {
      const j = await api('apps');
      setApps(j.apps);
      setAppCode((prev) => prev || j.apps[0]?.appCode || '');
      setErr('');
    } catch (e) {
      setErr(String((e as Error).message));
    }
  }, [api]);

  useEffect(() => {
    if (ready && token) void loadApps();
  }, [ready, token, loadApps]);

  if (!ready) return null;

  if (!token) {
    return (
      <main style={S.page}>
        <h1 style={{ fontSize: 18 }}>관리자 콘솔</h1>
        <p style={S.muted}>ADMIN_TOKEN을 입력하세요. 이 탭에서만 유지됩니다(sessionStorage).</p>
        <form
          style={S.row}
          onSubmit={(e) => {
            e.preventDefault();
            const v = new FormData(e.currentTarget).get('t') as string;
            if (v) {
              sessionStorage.setItem(TOKEN_KEY, v);
              setToken(v);
            }
          }}
        >
          <input name="t" type="password" placeholder="ADMIN_TOKEN" style={{ ...S.input, width: 320 }} autoFocus />
          <button style={S.btnPrimary}>입장</button>
        </form>
      </main>
    );
  }

  return (
    <main style={S.page}>
      <div style={{ ...S.row, justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={S.row}>
          <strong style={{ fontSize: 16 }}>공통 서버</strong>
          <select value={appCode} onChange={(e) => setAppCode(e.target.value)} style={S.input}>
            {apps.map((a) => (
              <option key={a.appCode} value={a.appCode}>
                {a.name} ({a.appCode}){a.active ? '' : ' · 비활성'}
              </option>
            ))}
          </select>
        </div>
        <button
          style={S.btn}
          onClick={() => {
            sessionStorage.removeItem(TOKEN_KEY);
            setToken('');
          }}
        >
          로그아웃
        </button>
      </div>

      {err && <div style={{ ...S.card, borderColor: '#e0b4b4', background: '#fdf5f5' }}>{err}</div>}

      <div style={{ ...S.row, borderBottom: '1px solid #e6e6e6', marginBottom: 16, gap: 0 }}>
        {(
          [
            ['announcements', '공지'],
            ['tickets', '문의'],
            ['settings', '설정'],
            ['apps', '앱'],
          ] as [Tab, string][]
        ).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            style={{
              ...S.btn,
              border: 0,
              borderBottom: tab === k ? '2px solid #1a1a1a' : '2px solid transparent',
              borderRadius: 0,
              fontWeight: tab === k ? 600 : 400,
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {!appCode && tab !== 'apps' ? (
        <p style={S.muted}>등록된 앱이 없습니다. “앱” 탭에서 먼저 등록하세요.</p>
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
  );
}

type Api = (path: string, init?: RequestInit) => Promise<any>;
type TabProps = { api: Api; appCode: string; onError: (m: string) => void };

// ───────────────────────── 공지 ─────────────────────────

function Announcements({ api, appCode, onError }: TabProps) {
  const [rows, setRows] = useState<Announcement[]>([]);
  const [form, setForm] = useState({ kind: 'notice', title: '', body: '', pinned: false, startsAt: '', endsAt: '' });

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
    try {
      await api('announcements', { method: 'POST', body: JSON.stringify({ appCode, ...form }) });
      setForm({ kind: 'notice', title: '', body: '', pinned: false, startsAt: '', endsAt: '' });
      onError('');
      await load();
    } catch (e) {
      onError(String((e as Error).message));
    }
  };

  const remove = async (id: string) => {
    if (!confirm('이 공지를 삭제할까요? 되돌릴 수 없습니다.')) return;
    try {
      await api(`announcements?id=${id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      onError(String((e as Error).message));
    }
  };

  const now = Date.now();

  return (
    <>
      <div style={S.card}>
        <div style={{ ...S.row, marginBottom: 8 }}>
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} style={S.input}>
            <option value="notice">공지</option>
            <option value="event">이벤트</option>
            <option value="update">업데이트</option>
          </select>
          <input
            placeholder="제목"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            style={{ ...S.input, flex: 1, minWidth: 240 }}
            maxLength={200}
          />
          <label style={S.row}>
            <input type="checkbox" checked={form.pinned} onChange={(e) => setForm({ ...form, pinned: e.target.checked })} />
            상단 고정
          </label>
        </div>
        <textarea
          placeholder="내용 (마크다운)"
          value={form.body}
          onChange={(e) => setForm({ ...form, body: e.target.value })}
          style={{ ...S.input, width: '100%', minHeight: 100, boxSizing: 'border-box' }}
          maxLength={10000}
        />
        <div style={{ ...S.row, marginTop: 8 }}>
          <span style={S.muted}>노출 기간</span>
          <input
            type="datetime-local"
            value={form.startsAt}
            onChange={(e) => setForm({ ...form, startsAt: e.target.value })}
            style={S.input}
          />
          <span style={S.muted}>~</span>
          <input
            type="datetime-local"
            value={form.endsAt}
            onChange={(e) => setForm({ ...form, endsAt: e.target.value })}
            style={S.input}
          />
          <span style={S.muted}>비우면 즉시 시작 · 무기한</span>
          <button style={{ ...S.btnPrimary, marginLeft: 'auto' }} onClick={submit}>
            발행
          </button>
        </div>
      </div>

      {rows.map((a) => {
        const started = new Date(a.startsAt).getTime() <= now;
        const ended = a.endsAt ? new Date(a.endsAt).getTime() < now : false;
        const state = ended ? '종료' : started ? '노출 중' : '예정';
        return (
          <div key={a.id} style={S.card}>
            <div style={{ ...S.row, justifyContent: 'space-between' }}>
              <div style={S.row}>
                <span style={{ ...S.muted, background: '#f2f2f2', padding: '2px 6px', borderRadius: 4 }}>{state}</span>
                {a.pinned && <span style={S.muted}>📌</span>}
                <strong>{a.title}</strong>
              </div>
              <button style={S.btn} onClick={() => remove(a.id)}>
                삭제
              </button>
            </div>
            <p style={{ whiteSpace: 'pre-wrap', margin: '8px 0', color: '#333' }}>{a.body}</p>
            <div style={S.muted}>
              {fmt(a.startsAt)} ~ {a.endsAt ? fmt(a.endsAt) : '무기한'}
            </div>
          </div>
        );
      })}
      {!rows.length && <p style={S.muted}>공지가 없습니다.</p>}
    </>
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
    <>
      <div style={{ ...S.row, marginBottom: 12 }}>
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={S.input}>
          <option value="">전체</option>
          <option value="open">미처리</option>
          <option value="replied">메모됨</option>
          <option value="resolved">완료</option>
        </select>
        <span style={S.muted}>
          익명 단방향 접수입니다 — 메모는 내부용이고 사용자에게 전달되지 않습니다.
        </span>
      </div>

      {rows.map((t) => (
        <div key={t.id} style={S.card}>
          <div style={{ ...S.row, justifyContent: 'space-between' }}>
            <div style={S.row}>
              <span style={{ ...S.muted, background: '#f2f2f2', padding: '2px 6px', borderRadius: 4 }}>
                {STATUS_KO[t.status] ?? t.status}
              </span>
              <strong>{CATEGORY_KO[t.category] ?? t.category}</strong>
              <span style={S.muted}>
                {t.platform ?? '—'}
                {t.appVersion ? ` · v${t.appVersion}` : ''}
              </span>
            </div>
            <span style={S.muted}>{fmt(t.createdAt)}</span>
          </div>
          <p style={{ whiteSpace: 'pre-wrap', margin: '8px 0' }}>{t.content}</p>
          <div style={S.row}>
            <input
              placeholder="내부 메모"
              defaultValue={t.reply ?? ''}
              style={{ ...S.input, flex: 1 }}
              maxLength={4000}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void patch(t.id, { reply: (e.target as HTMLInputElement).value });
              }}
            />
            <button style={S.btn} onClick={() => patch(t.id, { status: 'resolved' })}>
              완료 처리
            </button>
          </div>
        </div>
      ))}
      {!rows.length && <p style={S.muted}>문의가 없습니다.</p>}
    </>
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

  if (!s) return <p style={S.muted}>불러오는 중…</p>;

  const save = async (patch: Partial<Settings>) => {
    // 점검·강제업데이트는 전 사용자의 진입을 즉시 막는다 — 켤 때만 확인을 받는다.
    if (patch.maintenance === true && !confirm('점검 모드를 켜면 이 앱의 모든 사용자가 즉시 진입할 수 없습니다. 계속할까요?')) return;
    if (patch.minVersion && !confirm(`minVersion=${patch.minVersion} 미만 사용자는 즉시 진입이 차단됩니다. 계속할까요?`)) return;
    try {
      const j = await api('settings', { method: 'PATCH', body: JSON.stringify({ appCode, ...patch }) });
      setS(j.settings);
      onError('');
    } catch (e) {
      onError(String((e as Error).message));
    }
  };

  const field = (key: keyof Settings, label: string, hint?: string) => (
    <div style={{ marginBottom: 12 }}>
      <label style={S.label}>
        {label} {hint && <span style={{ color: '#aaa' }}>· {hint}</span>}
      </label>
      <input
        defaultValue={(s[key] as string | null) ?? ''}
        style={{ ...S.input, width: 400 }}
        onBlur={(e) => {
          if (e.target.value !== ((s[key] as string | null) ?? '')) void save({ [key]: e.target.value } as Partial<Settings>);
        }}
      />
    </div>
  );

  return (
    <div style={{ maxWidth: 560 }}>
      {field('minVersion', '최소 버전', '이 미만은 진입 차단(강제 업데이트)')}
      {field('latestVersion', '최신 버전', '이 미만은 소프트 안내')}
      {field('androidStoreUrl', 'Android 스토어 URL')}
      {field('iosStoreUrl', 'iOS 스토어 URL')}

      <div style={{ ...S.card, marginTop: 20, borderColor: s.maintenance ? '#e0b4b4' : '#e6e6e6' }}>
        <label style={S.row}>
          <input type="checkbox" checked={s.maintenance} onChange={(e) => save({ maintenance: e.target.checked })} />
          <strong>점검 모드</strong>
          {s.maintenance && <span style={{ color: '#c00' }}>— 현재 전 사용자 진입 차단 중</span>}
        </label>
        <div style={{ marginTop: 10 }}>
          <label style={S.label}>점검 화면 제목</label>
          <input
            defaultValue={s.maintenanceTitle ?? ''}
            style={{ ...S.input, width: '100%', boxSizing: 'border-box' }}
            onBlur={(e) => e.target.value !== (s.maintenanceTitle ?? '') && save({ maintenanceTitle: e.target.value })}
          />
        </div>
        <div style={{ marginTop: 10 }}>
          <label style={S.label}>점검 화면 내용</label>
          <textarea
            defaultValue={s.maintenanceBody ?? ''}
            style={{ ...S.input, width: '100%', minHeight: 70, boxSizing: 'border-box' }}
            onBlur={(e) => e.target.value !== (s.maintenanceBody ?? '') && save({ maintenanceBody: e.target.value })}
          />
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── 앱 ─────────────────────────

function AppsTab({ api, apps, reload, onError }: { api: Api; apps: App[]; reload: () => Promise<void>; onError: (m: string) => void }) {
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
    <>
      <div style={S.card}>
        <div style={S.row}>
          <input
            placeholder="app_code (예: myword)"
            value={form.appCode}
            onChange={(e) => setForm({ ...form, appCode: e.target.value })}
            style={S.input}
          />
          <input
            placeholder="표시 이름"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            style={S.input}
          />
          <button style={S.btnPrimary} onClick={create}>
            등록
          </button>
        </div>
        <p style={{ ...S.muted, marginBottom: 0, marginTop: 8 }}>
          app_code는 앱 번들과 디스코드 env 키(<code>DISCORD_TICKET_WEBHOOK_URL_&lt;대문자&gt;</code>)에 박히므로 나중에 바꿀 수 없습니다.
        </p>
      </div>

      {apps.map((a) => (
        <div key={a.appCode} style={{ ...S.card, ...S.row, justifyContent: 'space-between' }}>
          <div>
            <strong>{a.name}</strong> <span style={S.muted}>{a.appCode}</span>
            <div style={S.muted}>문의 24h 캡: {a.ticketDailyCap}건</div>
          </div>
          <div style={S.row}>
            <input
              type="number"
              defaultValue={a.ticketDailyCap}
              style={{ ...S.input, width: 90 }}
              min={1}
              onBlur={(e) => Number(e.target.value) !== a.ticketDailyCap && patch(a.appCode, { ticketDailyCap: Number(e.target.value) })}
            />
            <button style={S.btn} onClick={() => patch(a.appCode, { active: !a.active })}>
              {a.active ? '비활성화' : '활성화'}
            </button>
          </div>
        </div>
      ))}
    </>
  );
}
