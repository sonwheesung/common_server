// 정보 허브 가드 — `docs/INFO_HUB.md` §9.
//
// 실행:  node tools/_dv_info.ts                      (순수 계산만 · DB·서버 불필요)
//        BASE_URL=... ADMIN_TOKEN=... node tools/_dv_info.ts   (라우트까지)
//
// 🔴 **이 가드가 존재하는 첫째 이유는 "경로 간 대조"다**(docs/NEXT.md §1-4).
//    2026-09-07에 이름 붙인 그 빠진 검사 종류다 — 우리 가드 70개와 조각 가드 41개가
//    나란히 0개였던 칸이고, 문의 필터가 `stats`와 `tickets`에서 어긋난 채 살아남은 이유였다.
//    정보 허브에서는 **처음부터** 채운다.
//
//    왕복   한 계산과 그 역함수                     ← normalizeUrl 멱등성
//    환경 간 같은 계산을 여러 입력으로               ← parsePeriod 표기 변형
//    경로 간 서로 다른 두 코드가 같은 사실에 같은 답을 내는가  ← 목록 건수 vs 필터 조합
export {};

import {
  clipSummary,
  daysLeft,
  findList,
  grantAdapter,
  communityAdapter,
  parseFeed,
  stripTags,
  normalizeUrl,
  parseDate,
  parsePeriod,
  redact,
  SUMMARY_MAX,
  unescapeEntities,
} from '../lib/info.ts';

const BASE = (process.env.BASE_URL ?? '').replace(/\/$/, '');
const TOKEN = process.env.ADMIN_TOKEN ?? '';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const skipped: string[] = [];
function skip(name: string, why: string) {
  skipped.push(name);
  console.log(`  SKIP  ${name} — ${why}`);
}

console.log(`[_dv_info] ${BASE || '(순수 계산만)'}\n`);

// ── ① URL 정규화 — 중복 판정의 키다 ─────────────────────────────────────────
// 이게 틀리면 같은 공고가 매일 한 줄씩 늘어난다(INFO_HUB §4-1).
{
  const a = 'https://www.bizinfo.go.kr/view.do?pblancId=PBLN_1&utm_source=x&utm_medium=y';
  const b = 'https://www.bizinfo.go.kr/view.do?pblancId=PBLN_1';
  check('추적 파라미터를 뗀 두 URL이 같은 키가 된다', normalizeUrl(a) === normalizeUrl(b), `${normalizeUrl(a)} vs ${normalizeUrl(b)}`);
  check('normalizeUrl은 멱등이다(왕복)', normalizeUrl(normalizeUrl(a)) === normalizeUrl(a));
  check('해시는 제거된다', !normalizeUrl('https://x.kr/a#frag').includes('#'));
  check('끝 슬래시 유무가 같은 키가 된다', normalizeUrl('https://x.kr/a/') === normalizeUrl('https://x.kr/a'));
  check(
    '쿼리 순서가 달라도 같은 키가 된다',
    normalizeUrl('https://x.kr/a?b=2&a=1') === normalizeUrl('https://x.kr/a?a=1&b=2'),
  );
  // 🔴 대조군 — 진짜로 다른 공고가 같은 키로 뭉치면 하나가 사라진다. 위 검사만 있으면
  //    normalizeUrl이 상수를 반환해도 전부 통과한다(허위 오라클).
  check('다른 공고는 다른 키다', normalizeUrl('https://x.kr/a?id=1') !== normalizeUrl('https://x.kr/a?id=2'));
  check('URL이 아니면 원문을 유지한다', normalizeUrl('not a url') === 'not a url');
}

// ── ② 기간 파싱 — 마감이 정렬·알림의 축이다 ─────────────────────────────────
{
  const p1 = parsePeriod('2026-09-01 ~ 2026-09-30');
  check('기간 문자열에서 시작·마감을 뽑는다', p1.startsAt !== null && p1.endsAt !== null, JSON.stringify(p1));
  check('마감이 시작보다 뒤다', (p1.endsAt?.getTime() ?? 0) > (p1.startsAt?.getTime() ?? 0));

  // 🔴 여기가 이 가드의 핵심이다. '예산 소진시까지'를 마감 0(=지난 것)으로 읽으면
  //    상시 접수 공고가 목록에서 통째로 사라진다.
  for (const s of ['예산 소진시까지', '상시 접수', '선착순 접수', '모집 완료시', '']) {
    const p = parsePeriod(s);
    check(`"${s || '(빈 문자열)'}" 는 마감을 모름(null)으로 둔다`, p.endsAt === null, JSON.stringify(p));
  }
  check('YYYYMMDD 형식을 읽는다', parseDate('20260930') !== null);
  check('읽을 수 없는 날짜는 추측하지 않고 null이다', parseDate('언젠가') === null);
  check('daysLeft는 마감이 없으면 null이다', daysLeft(null) === null);
  check('daysLeft는 지난 마감에 음수를 준다', (daysLeft(new Date(Date.now() - 3 * 86_400_000)) ?? 0) < 0);
}

// ── ③ 요약 자르기 — 용량 규칙(§5-3) ─────────────────────────────────────────
{
  const long = 'ㄱ'.repeat(SUMMARY_MAX + 200);
  const clipped = clipSummary(long) ?? '';
  check('요약은 상한에서 잘린다', clipped.length === SUMMARY_MAX, `len=${clipped.length}`);
  check('자른 흔적을 남긴다', clipped.endsWith('…'));
  check('짧은 요약은 그대로 둔다', clipSummary('짧다') === '짧다');
  check('빈 요약은 null이다', clipSummary('   ') === null);
}

// ── ④ 목록 탐색 — "못 찾음"과 "0건"을 가른다 ────────────────────────────────
// 🔴 findList가 빈 배열을 반환하면 크론이 "0건 성공"으로 기록하고 화면이 거짓말한다.
{
  check('중첩된 응답에서 목록을 찾는다', (findList({ response: { body: { items: { item: [{ a: 1 }] } } } }) ?? []).length === 1);
  check('목록이 없으면 null이다(빈 배열이 아니다)', findList({ response: { body: {} } }) === null);
  check('원시값 배열은 목록으로 치지 않는다', findList({ x: [1, 2, 3] }) === null);
}

// ── ④-b 🔴 지원사업 어댑터 — **실제 K-Startup 응답 모양**으로 고정한다 ──────────
// 2026-09-07 실측 필드명이다. 여기가 조용히 깨지면 목록이 통째로 비거나(제목 없음)
// **매일 같은 3줄이 덮어써진다**(순번을 키로 쓰는 사고). 그 둘을 여기서 못 박는다.
{
  const real = [
    {
      id: 1, // 🔴 페이지 순번이다. 이걸 키로 쓰면 안 된다 — 아래에서 그걸 검사한다
      pbanc_sn: '179130',
      biz_pbanc_nm: '2026년 창업 페스티벌 &apos;창업 아이디어 경진대회&apos; 참가자 모집',
      detl_pg_url: 'https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do?schM=view&pbancSn=179130',
      pbanc_ctnt: '안녕하십니까. 참가자를 모집 합니다.',
      pbanc_rcpt_bgng_dt: '20260901',
      pbanc_rcpt_end_dt: '20260910',
      supt_biz_clsfc: '기술개발(R&amp;D)',
      supt_regin: '전국',
      pbanc_ntrp_nm: '서울창업센터 관악',
    },
    { id: 2, pbanc_sn: '179126', biz_pbanc_nm: '두 번째 공고', detl_pg_url: 'https://x.kr/b', pbanc_rcpt_end_dt: '20260916' },
  ];
  const out = grantAdapter(real);
  check('K-Startup 실제 응답에서 2건을 읽는다', out.length === 2, `n=${out.length}`);
  // 🔴 이 검사가 이 파일에서 제일 중요하다. 'id'(1,2,3…)를 키로 쓰면 매일 같은 줄을 덮어써
  //    목록이 영원히 3건에서 안 늘어난다 — 오류도 안 나고 조용히 그렇게 된다.
  check('고유 키는 pbanc_sn 이다 (페이지 순번 id 가 아니다)', out[0]?.externalId === '179130', String(out[0]?.externalId));
  check('두 항목의 키가 서로 다르다', out[0]?.externalId !== out[1]?.externalId);
  check('제목의 HTML 엔티티가 풀린다', out[0]?.title.includes("'") && !out[0]!.title.includes('&apos;'), out[0]?.title);
  check('태그의 HTML 엔티티도 풀린다', out[0]?.tags.some((t) => t === '기술개발(R&D)'), JSON.stringify(out[0]?.tags));
  check('접수 시작·마감을 YYYYMMDD 에서 읽는다', !!out[0]?.startsAt && !!out[0]?.endsAt);
  check('마감이 시작보다 뒤다', (out[0]!.endsAt!.getTime() > out[0]!.startsAt!.getTime()));
  check('지역 태그가 실린다', out[0]?.tags.includes('전국'), JSON.stringify(out[0]?.tags));
  // 대조군 — 제목이나 링크가 없는 행은 버린다(항목이 아니다)
  check('제목 없는 행은 버린다', grantAdapter([{ pbanc_sn: '1', detl_pg_url: 'https://x.kr' }]).length === 0);
  check('링크 없는 행은 버린다', grantAdapter([{ pbanc_sn: '1', biz_pbanc_nm: '제목만' }]).length === 0);
  check('엔티티 복원은 &amp; 를 마지막에 푼다', unescapeEntities('&amp;lt;') === '&lt;', String(unescapeEntities('&amp;lt;')));
}

// ── ④-c 🔴 RSS·Atom 파서 — 커뮤니티의 유일한 입구다 ────────────────────────
{
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>피드 제목</title>
    <item><title><![CDATA[첫 글 &amp; 제목]]></title><link>https://x.kr/a?utm_source=rss</link>
      <description>&lt;p&gt;본문 &lt;b&gt;굵게&lt;/b&gt;&lt;/p&gt;</description>
      <pubDate>Sun, 07 Sep 2026 01:02:03 GMT</pubDate><guid>tag:x.kr,2026:1</guid>
      <dc:creator>홍길동</dc:creator></item>
    <item><title>둘째 글</title><link>https://x.kr/b</link></item></channel></rss>`;
  const rows = parseFeed(rss);
  check('RSS에서 2건을 읽는다', (rows ?? []).length === 2, `n=${(rows ?? []).length}`);
  check('CDATA 안의 제목을 읽는다', rows?.[0]?.title === '첫 글 & 제목', String(rows?.[0]?.title));
  check('description의 HTML 태그를 걷어낸다', rows?.[0]?.description === '본문 굵게', String(rows?.[0]?.description));
  check('guid를 읽는다', rows?.[0]?.guid === 'tag:x.kr,2026:1', String(rows?.[0]?.guid));
  check('dc:creator를 작성자로 읽는다', rows?.[0]?.author === '홍길동', String(rows?.[0]?.author));

  const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title>
    <entry><title>아톰 글</title><link rel="alternate" href="https://y.kr/1"/>
      <summary>요약문</summary><updated>2026-09-06T00:00:00Z</updated><id>urn:1</id></entry></feed>`;
  const arows = parseFeed(atom);
  check('Atom에서 1건을 읽는다', (arows ?? []).length === 1);
  // 🔴 Atom의 링크는 본문이 아니라 href 속성에 있다. 이걸 놓치면 링크가 통째로 빈다.
  check('Atom 링크를 href 속성에서 읽는다', arows?.[0]?.link === 'https://y.kr/1', String(arows?.[0]?.link));

  // 🔴 못 읽으면 null (빈 배열이 아니다) — 빈 배열이면 크론이 "0건 성공"으로 기록하고 화면이 거짓말한다
  check('피드가 아니면 null이다', parseFeed('<html><body>안녕</body></html>') === null);
  check('항목 없는 피드도 null이다', parseFeed('<rss version="2.0"><channel><title>빈</title></channel></rss>') === null);
  check('빈 문자열도 null이다', parseFeed('') === null);
  check('stripTags는 빈 결과를 null로 준다', stripTags('<p> </p>') === null);

  const ci = communityAdapter(rows!);
  check('커뮤니티 어댑터가 2건으로 변환한다', ci.length === 2, `n=${ci.length}`);
  check('guid가 고유 키가 된다', ci[0]?.externalId === 'tag:x.kr,2026:1', String(ci[0]?.externalId));
  // guid가 없는 둘째 항목은 정규화한 URL로 떨어져야 한다
  check('guid 없으면 정규화한 URL이 키다', ci[1]?.externalId === normalizeUrl('https://x.kr/b'), String(ci[1]?.externalId));
  check('링크의 추적 파라미터가 제거된다', !ci[0]!.url.includes('utm_source'), ci[0]?.url);
  check('게시 시각을 읽는다', !!ci[0]?.publishedAt);
  check('커뮤니티 항목엔 마감이 없다', ci[0]?.endsAt === null);
}

// ── ⑤ 시크릿 가리기 — last_error는 화면·로그에 그대로 나간다 ────────────────
{
  const msg = redact('fetch https://api.kr/x?serviceKey=SUPERSECRET123&page=1 실패');
  check('오류 메시지에서 serviceKey가 가려진다', !msg.includes('SUPERSECRET123'), msg);
  check('가린 뒤에도 어디서 났는지는 남는다', msg.includes('api.kr'), msg);
}

// ── ⑥ 🔴 경로 간 대조 — 라우트가 있을 때만 ──────────────────────────────────
if (!BASE || !TOKEN) {
  skip('route-cross-check', 'BASE_URL·ADMIN_TOKEN 이 없다');
  skip('route-fail-closed', 'BASE_URL 이 없다');
} else {
  const get = (qs: string, token?: string) =>
    fetch(`${BASE}/api/admin/info${qs}`, token ? { headers: { authorization: `Bearer ${token}` } } : undefined);

  // fail-closed — 관리자 라우트의 기본 규율
  const noTok = await get('?kind=grant');
  check('토큰 없이 401', noTok.status === 401, `status=${noTok.status}`);
  const badTok = await get('?kind=grant', 'x'.repeat(40));
  check('틀린 토큰으로 401', badTok.status === 401, `status=${badTok.status}`);
  const badKind = await get('?kind=__nope__', TOKEN);
  check('모르는 kind는 400', badKind.status === 400, `status=${badKind.status}`);

  const r = await get('?kind=grant', TOKEN);
  const j = (await r.json()) as {
    ok: boolean;
    appScoped?: boolean;
    items?: unknown[];
    sources?: { id: string; lastRunAt: string | null; lastOkAt: string | null }[];
    expiredCount?: number;
  };
  check('grant 목록 200 + 형태', r.status === 200 && Array.isArray(j.items) && Array.isArray(j.sources), `status=${r.status}`);

  // 🔴 앱 스코프가 **없다는 것**을 서버가 선언하고, 실제로도 안 걸린다는 것을 대조한다.
  //    조용히 필터되면 운영자가 "이 앱 관련 공고"로 오독한다(INFO_HUB §1-1).
  check('서버가 appScoped=false 로 선언한다', j.appScoped === false, String(j.appScoped));
  const withApp = await get('?kind=grant&app=myword', TOKEN);
  const jApp = (await withApp.json()) as { items?: unknown[] };
  // 🔴 **비교 검사는 양쪽이 실제로 200이어야 의미가 있다.**
  //    2026-09-07 첫 실행에서 라우트가 500이었는데 이 세 검사가 `?? []` 폴백으로 0 === 0 이 되어
  //    **통과**했다 — `CLAUDE.md` 가 경고하는 "돌면서 아무것도 안 보는 검사"가 실제로 나왔다.
  //    그래서 응답이 성공인지를 비교의 **전제로** 건다.
  const okBoth = (a: Response, b: { items?: unknown[] }) => a.status === 200 && Array.isArray(b.items);
  check(
    '?app= 을 줘도 결과가 바뀌지 않는다(앱 무관)',
    okBoth(withApp, jApp) && r.status === 200 && (jApp.items ?? []).length === (j.items ?? []).length,
    `status=${withApp.status} ${(jApp.items ?? []).length} vs ${(j.items ?? []).length}`,
  );

  // 🔴 **경로 간 대조** — 필터가 두 곳에서 같은 정의를 쓰는가.
  //    `expired=show` 는 만료분을 포함하므로 기본 목록보다 **작을 수 없다**.
  //    (문의 쪽 결함이 정확히 이 형태였다: 목록은 거르고 stats는 안 걸렀다.)
  const all = await get('?kind=grant&expired=show', TOKEN);
  const jAll = (await all.json()) as { items?: unknown[]; expiredCount?: number };
  check(
    '만료 포함 목록 ≥ 기본 목록 (같은 정의를 쓴다)',
    okBoth(all, jAll) && r.status === 200 && (jAll.items ?? []).length >= (j.items ?? []).length,
    `status=${all.status} all=${(jAll.items ?? []).length} default=${(j.items ?? []).length}`,
  );
  check('expiredCount 는 음수가 아니다', (j.expiredCount ?? -1) >= 0, String(j.expiredCount));

  // 🔴 시도와 성공이 **따로** 내려온다(§5-4). 하나로 합치면 화면이 두 사실을 못 가른다.
  // ⚠ 소스가 0개면 이 검사도 공허하게 통과한다 — 그래서 **소스가 있다는 것**을 먼저 단언한다.
  //   (seed_info.ts 가 bizinfo·kstartup 둘을 넣어 두므로 0개면 그 자체가 고장이다.)
  check('수집원이 등록돼 있다', (j.sources ?? []).length > 0, `n=${(j.sources ?? []).length}`);
  const badState = (j.sources ?? []).filter((s) => !('lastRunAt' in s) || !('lastOkAt' in s));
  check('수집 상태가 시도·성공을 따로 내려보낸다', badState.length === 0, JSON.stringify(badState.slice(0, 2)));

  // 안 읽음 필터도 같은 정의를 써야 한다 — 전체보다 클 수 없다.
  const unread = await get('?kind=grant&unread=only', TOKEN);
  const jUnread = (await unread.json()) as { items?: unknown[] };
  check(
    '안 읽음 목록 ≤ 전체 목록 (같은 정의를 쓴다)',
    okBoth(unread, jUnread) && r.status === 200 && (jUnread.items ?? []).length <= (j.items ?? []).length,
    `status=${unread.status} unread=${(jUnread.items ?? []).length} all=${(j.items ?? []).length}`,
  );

  const community = await get('?kind=community', TOKEN);
  check('community 목록 200', community.status === 200, `status=${community.status}`);
}

// ── 스킵 대조 · 개수 바닥 ───────────────────────────────────────────────────
const KNOWN_SKIPS = ['route-cross-check', 'route-fail-closed'];
{
  const unknown = skipped.filter((n) => !KNOWN_SKIPS.includes(n));
  if (unknown.length > 0) {
    fail++;
    console.log(`  FAIL  등록되지 않은 스킵: ${unknown.join(', ')} — KNOWN_SKIPS 에 없다`);
  }
}

// ⚠ 검사를 늘렸으면 이 숫자도 같이 올린다. 귀찮은 게 요점이다(CLAUDE.md).
//   BASE_URL 없이 돌리면 순수 계산만 도므로 바닥이 그 개수다.
const MIN_CHECKS = BASE && TOKEN ? 63 : 52; // 2026-09-07: RSS/Atom 파서 검사 17개 추가
{
  const ran = pass + fail;
  if (ran < MIN_CHECKS) {
    fail++;
    console.log(`  FAIL  가드가 줄었다 — ${ran}개만 돌았다(최소 ${MIN_CHECKS})`);
  }
}

console.log(
  `\n${fail === 0 ? 'ALL PASS' : 'FAILED'} — pass=${pass} fail=${fail} (실행 ${pass + fail} / 최소 ${MIN_CHECKS}${
    skipped.length ? ` · 스킵 ${skipped.length}: ${skipped.join(',')}` : ''
  })`,
);
process.exit(fail === 0 ? 0 : 1);
