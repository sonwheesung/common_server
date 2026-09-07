// 정보 허브 수집원 등록 — `docs/INFO_HUB.md` §3.
//
// 실행:
//   node --env-file=.env.local tools/seed_info.ts
//   node --env-file=.env.local tools/seed_info.ts --endpoint bizinfo=https://... --endpoint kstartup=https://...
//
// 멱등하다 — 여러 번 돌려도 기존 행의 `enabled`·수집 상태를 건드리지 않는다.
// 🔴 **`enabled: false`로 만든다.** 서비스키가 아직 없는 상태에서 켜 두면 크론이 매일 실패만 쌓는다.
//    키를 넣고 재배포한 뒤 **콘솔에서 켜는 것**이 이 기능의 정상 순서다.
//
// ⚠ 엔드포인트는 코드가 아니라 **DB(config)** 에 있다. 소스를 늘리는 데 재배포가 필요 없어야 하기 때문이다
//    (`apps` 테이블이 앱 allowlist인 것과 같은 이유). 그래서 이 스크립트는 값을 **인자로** 받는다.
export {};

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { infoSources } from '../db/schema.ts';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL 이 없습니다. --env-file=.env.local 을 붙였는지 확인하세요.');
  process.exit(1);
}

/** `--endpoint <id>=<url>` 을 모은다. */
const endpoints = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--endpoint') {
    const [id, ...rest] = (process.argv[i + 1] ?? '').split('=');
    if (id && rest.length) endpoints.set(id.trim(), rest.join('=').trim());
  }
}

const SOURCES: { id: string; kind: string; label: string; config: Record<string, unknown> }[] = [
  {
    id: 'bizinfo',
    kind: 'grant',
    label: '지원사업 · 기업마당',
    config: {
      // ⚠ 공공데이터포털에서 활용신청 후 받은 **조회 엔드포인트**를 넣는다(`--endpoint bizinfo=...`).
      endpoint: endpoints.get('bizinfo') ?? '',
      keyEnv: 'DATA_GO_KR_SERVICE_KEY',
      keyParam: 'serviceKey',
      params: { dataType: 'json', numOfRows: '100' },
    },
  },
  {
    id: 'kstartup',
    kind: 'grant',
    label: '지원사업 · K-Startup',
    config: {
      endpoint: endpoints.get('kstartup') ?? '',
      keyEnv: 'DATA_GO_KR_SERVICE_KEY', // 🟢 기업마당과 **같은 키**다(둘 다 data.go.kr)
      keyParam: 'serviceKey',
      // 🔴 `cond[rcrt_prgs_yn::EQ]=Y` 가 **핵심이다** — 없으면 29,991건(역대 전체)이 오고,
      //    있으면 232건(모집 중)만 온다(2026-09-07 실측). 마감 지난 공고를 매일 긁어올 이유가 없다.
      params: {
        returnType: 'json',
        page: '1',
        perPage: '100',
        'cond[rcrt_prgs_yn::EQ]': 'Y',
      },
    },
  },
];

/**
 * 커뮤니티 — RSS·Atom 피드. **2026-09-07에 전부 직접 호출해 살아 있는 것만 남겼다**(응답 200 + item 존재).
 *
 * 🔴 Anthropic 은 공개 RSS 가 없다(`/rss.xml` · `/news/rss.xml` · `/feed.xml` · `/blog/rss.xml` 전부 404).
 *    Claude 관련 소식은 Hacker News · TechCrunch · The Verge 쪽에서 잡힌다 — 그걸로 대신한다.
 * ⚠ Reddit 은 짧은 간격으로 부르면 **429**를 준다. 하루 1회라 문제없지만, 수동으로 연달아 돌리지 말 것.
 * ⚠ VentureBeat · Stability AI · Indie Hackers · Disquiet · OKKY 는 그날 못 읽어 뺐다(404 · 429 · item 0).
 */
const FEEDS: { id: string; label: string; category: string; url: string }[] = [
  // ── AI 업계 소식 ──
  { id: 'rss:openai', label: 'AI · OpenAI News', category: 'ai', url: 'https://openai.com/blog/rss.xml' },
  { id: 'rss:deepmind', label: 'AI · Google DeepMind', category: 'ai', url: 'https://deepmind.google/blog/rss.xml' },
  { id: 'rss:huggingface', label: 'AI · Hugging Face', category: 'ai', url: 'https://huggingface.co/blog/feed.xml' },
  // 이미지·동영상 생성 모델 소식이 여기 제일 빨리 뜬다
  { id: 'rss:replicate', label: 'AI · Replicate', category: 'ai', url: 'https://replicate.com/blog/rss' },
  { id: 'rss:tc-ai', label: 'AI · TechCrunch', category: 'ai', url: 'https://techcrunch.com/category/artificial-intelligence/feed/' },
  { id: 'rss:verge-ai', label: 'AI · The Verge', category: 'ai', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml' },

  // ── 국내 개발 ──
  { id: 'rss:geeknews', label: '국내 · GeekNews', category: 'devkr', url: 'https://news.hada.io/rss/news' },
  { id: 'rss:44bits', label: '국내 · 44BITS', category: 'devkr', url: 'https://www.44bits.io/ko/feed/all' },
  { id: 'rss:yozmit', label: '국내 · 요즘IT', category: 'devkr', url: 'https://yozm.wishket.com/magazine/feed/' },
  { id: 'rss:kakaotech', label: '국내 · 카카오테크', category: 'devkr', url: 'https://tech.kakao.com/feed/' },
  { id: 'rss:tosstech', label: '국내 · 토스테크', category: 'devkr', url: 'https://toss.tech/rss.xml' },
  { id: 'rss:daangn', label: '국내 · 당근테크', category: 'devkr', url: 'https://medium.com/feed/daangn' },

  // ── 앱·게임 아이디어 ──
  { id: 'rss:hn-show', label: '아이디어 · Show HN', category: 'idea', url: 'https://hnrss.org/show' },
  { id: 'rss:hn-front', label: '아이디어 · Hacker News', category: 'idea', url: 'https://hnrss.org/frontpage' },
  { id: 'rss:producthunt', label: '아이디어 · Product Hunt', category: 'idea', url: 'https://www.producthunt.com/feed' },
  { id: 'rss:r-sideproject', label: '아이디어 · r/SideProject', category: 'idea', url: 'https://www.reddit.com/r/SideProject/.rss' },
  { id: 'rss:r-gameideas', label: '아이디어 · r/gameideas', category: 'idea', url: 'https://www.reddit.com/r/gameideas/.rss' },
];

for (const f of FEEDS) {
  SOURCES.push({
    id: f.id,
    kind: 'community',
    label: f.label,
    // 🟢 피드는 인증키가 없다 — `keyEnv`를 비워두면 `buildRequestUrl`이 키 없이 URL을 만든다.
    config: { endpoint: f.url, category: f.category, params: {} },
  });
}

const client = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const db = drizzle(client);

for (const s of SOURCES) {
  await db
    .insert(infoSources)
    // 🔴 지원사업(grant)은 서비스키가 필요하므로 꺼서 만든다. 커뮤니티(RSS)는 키가 없어 바로 돈다.
    .values({ id: s.id, kind: s.kind, label: s.label, config: s.config, enabled: s.kind === 'community' })
    // 🔴 기존 행의 enabled·lastOkAt·lastError를 덮지 않는다 — 운영자가 정한 상태이지
    //    이 스크립트가 정할 값이 아니다(문의 상태 규약과 같은 계열). endpoint만 갱신한다.
    .onConflictDoUpdate({
      target: infoSources.id,
      set: { label: s.label, ...((s.config as Record<string, unknown>).endpoint ? { config: s.config } : {}) },
    });
}

const rows = await db.select().from(infoSources);
console.log('등록된 수집원:');
for (const r of rows) {
  const ep = (r.config as Record<string, unknown>)?.endpoint;
  const cat = (r.config as Record<string, unknown>)?.category ?? '-';
  console.log(
    `  ${r.id.padEnd(18)} ${r.kind.padEnd(10)} ${String(cat).padEnd(7)} enabled=${String(r.enabled).padEnd(5)} ${ep ? '✅' : '⚠ endpoint 없음'}`,
  );
}
console.log('\n다음 순서:');
console.log('  ① data.go.kr 에서 기업마당·K-Startup 활용신청 → 서비스키 발급 (사람)');
console.log('  ② 발급한 엔드포인트를 --endpoint 로 다시 실행');
console.log('  ③ Vercel env 에 DATA_GO_KR_SERVICE_KEY 넣고 재배포');
console.log('  ④ 콘솔 → 정보 → 지원사업 에서 수집원을 "켜기"');

await client.end();
