// 정보 허브 — 수집원 어댑터와 순수 변환. 설계는 `docs/INFO_HUB.md`.
//
// 🔴 이 파일의 규율 둘:
//  ① **엔드포인트·키워드는 코드가 아니라 `info_sources.config`에 있다.** 소스를 늘리는 데 재배포가
//     필요 없어야 한다(`apps` 테이블이 allowlist인 것과 같은 이유). 코드는 **응답 모양을 아는 어댑터**만 갖는다.
//  ② **모르면 던진다.** 응답에서 목록을 못 찾으면 빈 배열을 돌려주지 않고 throw 한다 —
//     "0건 성공"으로 기록되면 화면이 *"새 공고 없음"* 으로 거짓말한다(§5-4가 막으려는 바로 그것).

/** 저장하는 요약의 최대 길이. 본문은 저장하지 않는다 — Supabase 무료 500MB(§5-3). */
export const SUMMARY_MAX = 500;

/** 한 회차에 **동시에** 부르는 소스 수. 외부 서버에 한꺼번에 몰리지 않게 나눈다. */
export const SOURCE_BATCH = 4;

/** 한 회차의 시간 예산(ms). 이걸 넘기면 남은 소스는 다음 회차로 미룬다 —
 *  `lastRunAt` 오름차순이라 **미뤄진 것이 다음에 제일 먼저** 돈다(굶지 않는다). */
export const RUN_BUDGET_MS = 25_000;

/** 한 회차에 볼 소스 수의 상한. 예산이 남아도 여기서 멈춘다(폭주 방지). */
export const MAX_SOURCES_PER_RUN = 24;

/** 한 소스에서 한 번에 가져오는 최대 항목 수. */
export const ITEMS_PER_FETCH = 100;

/** 수집기가 밝히는 신원. 🔴 이게 없으면 Reddit 이 **429**로 막는다(2026-09-07 실측).
 *  공개 피드를 가져가는 쪽이 누구인지 밝히는 게 맞고, 막혔을 때 상대가 연락할 곳도 남긴다. */
export const USER_AGENT = 'common-server-info-hub/1.0 (+https://common-server.vercel.app)';

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
  /** 화면 필터 축. 소스 설정(`config.category`)에서 크론이 찍는다 — 어댑터는 모른다. */
  category?: string | null;
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

/** 공공 API 응답에 `&apos;` `&amp;` 같은 HTML 엔티티가 그대로 실려 온다(K-Startup 실측).
 *  화면에 날것으로 뜨면 제목이 깨져 보이므로 저장 전에 되돌린다. */
export function unescapeEntities(s: string | null): string | null {
  if (!s) return s;
  return s
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&'); // 🔴 &amp; 는 **마지막**에 — 먼저 풀면 &amp;lt; 가 < 로 이중 복원된다
}

/** 태그를 걷어내고 사람이 읽는 텍스트만 남긴다. RSS `description`은 HTML 덩어리로 오는 게 보통이다. */
export function stripTags(html: string | null): string | null {
  if (!html) return null;
  // 🔴 **순서가 중요하다: 엔티티를 먼저 풀고 태그를 걷어낸다.**
  //    RSS `description`은 대개 `&lt;p&gt;…` 처럼 **이스케이프된 HTML**로 온다 —
  //    태그를 먼저 지우면 지울 태그가 없고, 그 뒤에 엔티티를 풀면 `<p>`가 화면에 그대로 뜬다.
  //    (2026-09-07 가드가 이 순서 오류를 잡았다.)
  const unescaped = unescapeEntities(html) ?? '';
  return unescaped.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() || null;
}

/**
 * RSS 2.0 · Atom 피드를 행 목록으로. **의존성을 안 쓴다** — 필요한 건 필드 6개뿐이고,
 * XML 파서를 하나 들이면 그것도 유지 대상이 된다.
 *
 * 🔴 못 읽으면 **null**을 준다(빈 배열이 아니다). `findList`와 같은 규율이다 —
 *    "0건 성공"으로 기록되면 화면이 *"새 글 없음"* 으로 거짓말한다.
 *
 * ⚠ 이건 **피드용**이다. 공공 API가 주는 XML(기업마당 등)은 스키마가 전혀 달라 여기서 안 읽힌다.
 */
export function parseFeed(xml: string): Record<string, string | null>[] | null {
  if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(xml)) return null;
  // \1 역참조로 여는 태그와 닫는 태그를 맞춘다 — <item>…</item> 과 <entry>…</entry> 를 한 정규식으로.
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi);
  if (!blocks || !blocks.length) return null;

  const tag = (b: string, name: string): string | null => {
    // ⚠ 템플릿 문자열 안이므로 정규식 escape 를 한 번 더 준다(`\s` → 실제 `\s`).
    const m = b.match(new RegExp(String.raw`<${name}(?:\s[^>]*)?>([\s\S]*?)</${name}>`, 'i'));
    if (!m) return null;
    const cdata = m[1].match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
    return (cdata ? cdata[1] : m[1]).trim() || null;
  };

  return blocks.map((b) => {
    // Atom 의 링크는 본문이 아니라 href 속성에 있다. RSS 는 본문이다 — 둘 다 본다.
    const href = b.match(/<link[^>]*\shref=["']([^"']+)["']/i)?.[1] ?? null;
    return {
      title: unescapeEntities(tag(b, 'title')),
      link: href ?? tag(b, 'link'),
      // description(RSS) · summary/content(Atom). 길면 뒤에서 잘린다.
      description: stripTags(tag(b, 'description') ?? tag(b, 'summary') ?? tag(b, 'content')),
      pubDate: tag(b, 'pubDate') ?? tag(b, 'published') ?? tag(b, 'updated') ?? tag(b, 'dc:date'),
      guid: tag(b, 'guid') ?? tag(b, 'id'),
      author: unescapeEntities(tag(b, 'author') ?? tag(b, 'dc:creator') ?? tag(b, 'name')),
    };
  });
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
// ✅ **2026-09-07 실제 응답으로 검증했다**(K-Startup 개발계정 승인 직후 로컬 호출).
//    추측했던 camelCase 후보(`pblancNm` 등)는 **전부 틀렸다** — 실제는 snake_case 약어다.
//
//    🔴 그 과정에서 잡은 함정 하나: 응답 행에 `id` 필드가 있는데 그건 **페이지 안 순번(1,2,3…)** 이다.
//       중복 키로 쓰면 매일 **다른 공고가 같은 줄을 덮어써서** 목록이 3건에서 안 늘어난다.
//       진짜 고유 키는 `pbanc_sn`(공고 일련번호)이다. 후보 목록에 'id'를 남겨두면 안 되는 이유다.

export type Adapter = (rows: unknown[]) => NormalizedItem[];

/**
 * 지원사업 공고. **K-Startup 응답으로 검증된 필드명**(2026-09-07)에 기업마당 계열 후보를 함께 둔다.
 *
 * 🔴 `externalId`에 `id`를 **절대 넣지 않는다** — 그건 페이지 순번이다(위 주석).
 */
export const grantAdapter: Adapter = (rows) =>
  rows.flatMap((raw) => {
    const row = raw as Record<string, unknown>;
    // 공고명 — K-Startup `biz_pbanc_nm` / 통합공고명 `intg_pbanc_biz_nm` / 기업마당 `pblancNm`
    const title = unescapeEntities(pick(row, ['biz_pbanc_nm', 'intg_pbanc_biz_nm', 'pblancNm', 'title']));
    const link = pick(row, ['detl_pg_url', 'biz_gdnc_url', 'pblancUrl', 'detailUrl', 'url']);
    if (!title || !link) return []; // 제목·링크가 없으면 항목이 아니다
    const url = link.startsWith('http') ? link : `https://${link}`;

    // 🔴 고유 키. `pbanc_sn`이 정본이고, 없으면 정규화한 URL로 떨어진다.
    const externalId = pick(row, ['pbanc_sn', 'pblancId']) ?? normalizeUrl(url);

    const { startsAt: pStart, endsAt: pEnd } = parsePeriod(pick(row, ['reqstBeginEndDe', 'applicationPeriod']));

    return [
      {
        externalId,
        title,
        url: normalizeUrl(url),
        summary: clipSummary(unescapeEntities(pick(row, ['pbanc_ctnt', 'bsnsSumryCn', 'summary']))),
        author: null,
        publishedAt: null, // K-Startup은 등록일을 안 준다 — 없는 값을 지어내지 않는다
        startsAt: parseDate(pick(row, ['pbanc_rcpt_bgng_dt', 'reqstBeginDe'])) ?? pStart,
        endsAt: parseDate(pick(row, ['pbanc_rcpt_end_dt', 'reqstEndDe'])) ?? pEnd,
        // 태그는 **화면에서 걸러 읽는 축**이다: 분야 · 지역 · 업력 요건.
        // 업력(`biz_enyy`)이 특히 값지다 — "창업 3년 이내"가 우리 자격의 병목이라서다.
        // ⚠ 태그에도 엔티티가 실려 온다(`기술개발(R&amp;D)` 실측) — 제목·요약만 풀면 여기서 새어 나온다.
        tags: [
          pick(row, ['supt_biz_clsfc', 'pldirSportRealmLclasCodeNm']),
          pick(row, ['supt_regin']),
          pick(row, ['pbanc_ntrp_nm', 'jrsdInsttNm']),
        ]
          .map((x) => unescapeEntities(x))
          .filter((x): x is string => !!x),
      },
    ];
  });

/** 커뮤니티(RSS·Atom 피드 · 나중에 스레드 키워드 검색). 작성자와 게시 시각이 축이고 마감이 없다. */
export const communityAdapter: Adapter = (rows) =>
  rows.flatMap((raw) => {
    const row = raw as Record<string, unknown>;
    const title = pick(row, ['title', 'text', 'content']);
    const link = pick(row, ['link', 'permalink', 'url']);
    if (!title || !link) return [];
    return [
      {
        // 🔴 guid 가 있으면 그걸 쓴다. 없으면 정규화한 URL —
        //    원문 URL을 그대로 키로 쓰면 추적 파라미터가 붙는 순간 같은 글이 두 줄이 된다.
        externalId: pick(row, ['guid', 'id']) ?? normalizeUrl(link),
        title: clipSummary(title) ?? title,
        url: normalizeUrl(link),
        summary: clipSummary(pick(row, ['description', 'summary'])),
        author: pick(row, ['author', 'creator', 'username']),
        publishedAt: parseDate(pick(row, ['pubDate', 'timestamp', 'published'])),
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
  const raw = keyEnv ? (process.env[keyEnv] ?? '') : ''; // 호출 시점 읽기(규약)
  if (keyEnv && !raw) return null;
  // 🔴 공공데이터포털은 인증키를 **Encoding·Decoding 두 벌**로 준다. 아래에서 `searchParams.set`이
  //    다시 인코딩하므로, Encoding 키를 그대로 넣으면 `%2F`가 `%252F`가 되어 인증이 깨진다.
  //    포털 안내조차 "둘 중 되는 걸 쓰라"고만 한다 — 그래서 **어느 쪽을 넣어도 되게** 여기서 정규화한다.
  const key = /%[0-9A-Fa-f]{2}/.test(raw) ? decodeURIComponent(raw) : raw;
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
