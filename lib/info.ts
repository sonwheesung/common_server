// 정보 허브 — 수집원 어댑터와 순수 변환. 설계는 `docs/INFO_HUB.md`.
//
// 🔴 이 파일의 규율 둘:
//  ① **엔드포인트·키워드는 코드가 아니라 `info_sources.config`에 있다.** 소스를 늘리는 데 재배포가
//     필요 없어야 한다(`apps` 테이블이 allowlist인 것과 같은 이유). 코드는 **응답 모양을 아는 어댑터**만 갖는다.
//  ② **모르면 던진다.** 응답에서 목록을 못 찾으면 빈 배열을 돌려주지 않고 throw 한다 —
//     "0건 성공"으로 기록되면 화면이 *"새 공고 없음"* 으로 거짓말한다(§5-4가 막으려는 바로 그것).

/** 저장하는 요약의 최대 길이. 본문은 저장하지 않는다 — Supabase 무료 500MB(§5-3). */
export const SUMMARY_MAX = 500;

/** 한 회차에 처리하는 소스 수. 서버리스 한 요청이 오래 못 도므로 나눠 돈다(§5-2). */
export const SOURCES_PER_RUN = 3;

/** 한 소스에서 한 번에 가져오는 최대 항목 수. */
export const ITEMS_PER_FETCH = 100;

/** 외부 호출 타임아웃(ms). 하나가 늦어도 회차 전체를 잡아먹지 않게. */
export const FETCH_TIMEOUT_MS = 12_000;

/** 수집기가 만들어 내는 정규화된 항목. DB 컬럼과 1:1이다. */
export type NormalizedItem = {
  externalId: string;
  title: string;
  url: string;
  summary: string | null;
  author: string | null;
  publishedAt: Date | null;
  startsAt: Date | null;
  endsAt: Date | null;
  tags: string[];
};

// ───────────────────────── 순수 변환 ─────────────────────────

/** 추적 파라미터를 떼고 URL을 정규화한다.
 *
 *  🔴 **왜 필요한가**: `external_id`가 없는 소스에서는 이 값이 곧 중복 판정 키다.
 *  URL 원문을 그대로 쓰면 같은 공고가 `?utm_source=` 만 달고 와도 **다른 항목**이 되어
 *  매일 한 줄씩 늘어난다(§4-1). */
export function normalizeUrl(raw: string): string {
  const s = (raw ?? '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    const drop = /^(utm_|fbclid$|gclid$|igshid$|ref$|referrer$|spm$|from$)/i;
    for (const k of [...u.searchParams.keys()]) if (drop.test(k)) u.searchParams.delete(k);
    u.hash = '';
    u.searchParams.sort();
    // 끝의 슬래시 하나는 의미가 없다 — 있고 없고로 두 줄이 되면 안 된다.
    const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : u.pathname;
    return `${u.protocol}//${u.host}${path}${u.search}`;
  } catch {
    return s; // URL이 아니면 원문 그대로 — 최소한 같은 값끼리는 묶인다
  }
}

/** 요약을 자른다. 자른 흔적을 남긴다 — 원문이 더 있다는 사실 자체가 정보다. */
export function clipSummary(raw: string | null | undefined): string | null {
  const s = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length <= SUMMARY_MAX ? s : `${s.slice(0, SUMMARY_MAX - 1)}…`;
}

/** 'YYYYMMDD' · 'YYYY-MM-DD' · ISO 를 Date로. 못 읽으면 null(추측하지 않는다). */
export function parseDate(raw: unknown): Date | null {
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const digits = s.replace(/[^0-9]/g, '');
  if (digits.length === 8) {
    const d = new Date(`${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}T00:00:00+09:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `'2026-09-01 ~ 2026-09-30'` 같은 기간 문자열에서 시작·마감을 뽑는다.
 *  ⚠ `'예산 소진시까지'` · `'상시 접수'` 처럼 날짜가 없는 표현이 흔하다 — 그때는 **둘 다 null**이다.
 *  🔴 그걸 "마감 없음"이 아니라 **"마감을 모름"** 으로 다뤄야 한다(정렬에서 맨 뒤로 보낸다). */
export function parsePeriod(raw: unknown): { startsAt: Date | null; endsAt: Date | null } {
  const s = String(raw ?? '').trim();
  const m = s.match(/(\d{4}[.\-/]?\d{2}[.\-/]?\d{2})\s*[~\-–]\s*(\d{4}[.\-/]?\d{2}[.\-/]?\d{2})/);
  if (m) return { startsAt: parseDate(m[1]), endsAt: parseDate(m[2]) };
  const one = s.match(/(\d{4}[.\-/]?\d{2}[.\-/]?\d{2})/);
  return { startsAt: null, endsAt: one ? parseDate(one[1]) : null };
}

/** 남은 일수(D-day). 마감이 없으면 null — 화면이 "상시"로 적는다. */
export function daysLeft(endsAt: Date | null, now: Date = new Date()): number | null {
  if (!endsAt) return null;
  const day = 86_400_000;
  return Math.ceil((endsAt.getTime() - now.getTime()) / day);
}

/** 응답 어디에 목록이 들어 있는지 찾는다. 공공 API는 래핑이 제각각이라 몇 겹을 벗겨야 한다.
 *  🔴 못 찾으면 **null**을 돌려주고, 호출부가 그걸 오류로 만든다. 빈 배열로 바꾸지 않는다. */
export function findList(payload: unknown): unknown[] | null {
  const seen = new Set<unknown>();
  const walk = (node: unknown, depth: number): unknown[] | null => {
    if (depth > 6 || node === null || typeof node !== 'object') return null;
    if (seen.has(node)) return null;
    seen.add(node);
    if (Array.isArray(node)) return node.length && typeof node[0] === 'object' ? node : null;
    for (const v of Object.values(node as Record<string, unknown>)) {
      const hit = walk(v, depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  return walk(payload, 0);
}

/** 여러 후보 키 중 처음 값이 있는 것. 공공 API는 같은 뜻에 다른 이름을 쓴다. */
const pick = (row: Record<string, unknown>, keys: string[]): string | null => {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && String(v).trim()) return String(v).trim();
  }
  return null;
};

// ───────────────────────── 어댑터 ─────────────────────────
//
// ⚠ **2026-09-07 현재 어느 어댑터도 실제 응답으로 검증되지 않았다.** `DATA_GO_KR_SERVICE_KEY`가
//    아직 없어서다(`docs/NEXT.md §0`). 그래서 필드 이름을 **후보 목록**으로 두고, 아무것도 못 읽으면
//    던진다 — 첫 실행의 `last_error`가 실제 응답의 모양을 알려주고, 그때 이 목록을 좁힌다.
//    🔴 "빈 목록을 성공으로 기록"하지 않는 것이 이 설계의 전부다.

export type Adapter = (rows: unknown[]) => NormalizedItem[];

/** 지원사업 공고(기업마당·K-Startup 계열). 두 API의 필드명이 달라 후보를 합쳐 둔다. */
export const grantAdapter: Adapter = (rows) =>
  rows.flatMap((raw) => {
    const row = raw as Record<string, unknown>;
    const title = pick(row, ['pblancNm', 'bizPbancNm', 'intgPbancBizNm', 'title', 'pbancNm']);
    const link = pick(row, ['pblancUrl', 'detailUrl', 'url', 'link', 'pbancDetlUrl', 'dtlUrl']);
    if (!title || !link) return []; // 제목·링크가 없으면 항목이 아니다
    const url = link.startsWith('http') ? link : `https://www.bizinfo.go.kr${link}`;
    const period = pick(row, ['reqstBeginEndDe', 'pbancRcptBgngDt', 'applicationPeriod', 'rcptPd']);
    const { startsAt, endsAt } = parsePeriod(period);
    const endOnly = parseDate(pick(row, ['pbancRcptEndDt', 'reqstEndDe', 'endDate']));
    const startOnly = parseDate(pick(row, ['pbancRcptBgngDt', 'reqstBeginDe', 'startDate']));
    return [
      {
        externalId: pick(row, ['pblancId', 'pbancSn', 'id']) ?? normalizeUrl(url),
        title,
        url: normalizeUrl(url),
        summary: clipSummary(pick(row, ['bsnsSumryCn', 'pbancCtnt', 'summary', 'cn'])),
        author: null,
        publishedAt: parseDate(pick(row, ['creatPnttm', 'regDt', 'pbancNtrpRgstDt'])),
        startsAt: startsAt ?? startOnly,
        endsAt: endsAt ?? endOnly,
        tags: [pick(row, ['pldirSportRealmLclasCodeNm', 'supportRealm', 'bizGbn']), pick(row, ['jrsdInsttNm', 'excInsttNm', 'organ'])].filter(
          (x): x is string => !!x,
        ),
      },
    ];
  });

/** 커뮤니티(스레드 키워드 검색 · RSS). 작성자와 게시 시각이 축이고 마감이 없다. */
export const communityAdapter: Adapter = (rows) =>
  rows.flatMap((raw) => {
    const row = raw as Record<string, unknown>;
    const title = pick(row, ['text', 'title', 'content', 'description']);
    const link = pick(row, ['permalink', 'link', 'url']);
    if (!title || !link) return [];
    return [
      {
        externalId: pick(row, ['id', 'guid']) ?? normalizeUrl(link),
        title: clipSummary(title) ?? title,
        url: normalizeUrl(link),
        summary: null, // 커뮤니티는 제목이 곧 본문이라 따로 두지 않는다
        author: pick(row, ['username', 'author', 'creator']),
        publishedAt: parseDate(pick(row, ['timestamp', 'pubDate', 'published'])),
        startsAt: null,
        endsAt: null,
        tags: [],
      },
    ];
  });

export const ADAPTERS: Record<string, Adapter> = { grant: grantAdapter, community: communityAdapter };

/** 소스 설정에서 호출 URL을 만든다. 시크릿은 **여기서만** 붙고 로그·응답에 실리지 않는다.
 *  🔴 키가 없으면 null — 호출부가 "미설정"으로 건너뛴다(조용한 실패가 아니라 화면에 뜬다). */
export function buildRequestUrl(config: Record<string, unknown>): string | null {
  const endpoint = typeof config.endpoint === 'string' ? config.endpoint : '';
  if (!endpoint) return null;
  const keyEnv = typeof config.keyEnv === 'string' ? config.keyEnv : '';
  const key = keyEnv ? (process.env[keyEnv] ?? '') : ''; // 호출 시점 읽기(규약)
  if (keyEnv && !key) return null;
  const u = new URL(endpoint);
  const params = (config.params ?? {}) as Record<string, string>;
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  if (keyEnv) u.searchParams.set(typeof config.keyParam === 'string' ? config.keyParam : 'serviceKey', key);
  return u.toString();
}

/** 오류 메시지에서 시크릿이 새지 않게 URL을 가린다. 로그·`last_error`·화면에 그대로 나가는 값이다. */
export function redact(msg: string): string {
  return msg.replace(/([?&](serviceKey|access_token|key|apiKey)=)[^&\s]+/gi, '$1<redacted>').slice(0, 300);
}
