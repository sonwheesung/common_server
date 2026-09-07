// 정보 훑기 — 피드를 그 자리에서 가져와 **원자료**를 뱉는다. 요약·판단은 하지 않는다(그건 Claude 몫).
//
// 실행:
//   node --env-file=.env.local .claude/skills/info-scan/fetch.mjs [옵션]
//     --days 5           최근 며칠 (기본 5)
//     --category ai      ai | devkr | idea  (여러 번 줄 수 있다. 없으면 전부)
//     --q 이미지          제목·요약 키워드 (여러 번 줄 수 있다. OR)
//     --limit 200        상한 (기본 200)
//
// 🔴 **설계 두 가지가 이 파일의 전부다:**
//  ① **파서를 새로 안 쓴다** — `lib/info.ts`의 것을 그대로 쓴다. 가드(`tools/_dv_info.ts`)가
//     검증하는 그 코드다. 스킬이 자기 파서를 따로 가지면 **두 곳이 같은 사실을 다르게 읽는다**
//     (docs/NEXT.md §1-4에서 이름 붙인 그 결함 종류다).
//  ② **피드 목록을 코드에 안 박는다** — `info_sources` 테이블에서 읽는다. 소스를 늘리는 데
//     코드 변경이 없어야 한다는 §3-3 원칙 그대로다. 수집이 꺼져 있어도(enabled=false) 목록은 쓴다 —
//     저장은 안 하지만 **어디를 볼지는 거기 적혀 있다.**
export {};

import postgres from 'postgres';
import { parseFeed, stripTags, unescapeEntities, USER_AGENT } from '../../../lib/info.ts';

const arg = (name, fallback = null) => {
  const out = [];
  for (let i = 2; i < process.argv.length; i++) if (process.argv[i] === `--${name}`) out.push(process.argv[i + 1]);
  return out.length ? out : fallback;
};

const days = Number(arg('days', ['5'])[0]);
const cats = arg('category');
const terms = (arg('q') ?? []).map((t) => t.toLowerCase());
const limit = Number(arg('limit', ['200'])[0]);

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL 이 없습니다. --env-file=.env.local 을 붙였는지 확인하세요.');
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL, { max: 2, prepare: false });
const sources = await sql`select id, label, config from info_sources where kind = 'community' order by id`;
await sql.end();

const picked = sources.filter((s) => !cats || cats.includes(String(s.config?.category ?? '')));
if (!picked.length) {
  console.error(`해당하는 수집원이 없습니다. (요청한 분류: ${cats?.join(',') ?? '전부'})`);
  process.exit(1);
}

const cutoff = Date.now() - days * 86_400_000;
const items = [];
const failed = [];

await Promise.all(
  picked.map(async (s) => {
    const url = String(s.config?.endpoint ?? '');
    if (!url) return failed.push({ id: s.id, why: 'endpoint 없음' });
    try {
      const res = await fetch(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return failed.push({ id: s.id, why: `HTTP ${res.status}` });
      const rows = parseFeed(await res.text());
      // 🔴 못 읽으면 **실패로 적는다**. 조용히 0건으로 넘기면 "그 주엔 소식이 없었다"로 읽힌다.
      if (!rows) return failed.push({ id: s.id, why: '피드를 읽지 못함' });
      for (const r of rows) {
        if (!r.title || !r.link) continue;
        const t = r.pubDate ? new Date(r.pubDate).getTime() : NaN;
        // ⚠ 날짜를 못 읽는 피드가 있다. **버리지 않는다** — 모르는 것을 오래된 것으로 취급하면 조용히 사라진다.
        if (Number.isFinite(t) && t < cutoff) continue;
        items.push({
          source: s.label,
          category: String(s.config?.category ?? ''),
          title: unescapeEntities(r.title),
          url: r.link,
          summary: stripTags(r.description)?.slice(0, 300) ?? null,
          date: Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null,
        });
      }
    } catch (e) {
      failed.push({ id: s.id, why: (e?.message ?? String(e)).slice(0, 80) });
    }
  }),
);

const matched = terms.length
  ? items.filter((i) => terms.some((t) => `${i.title} ${i.summary ?? ''}`.toLowerCase().includes(t)))
  : items;

// 날짜 없는 항목은 뒤로(버리지 않는다).
matched.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
const shown = matched.slice(0, limit);

console.log(
  `# 정보 훑기 — 최근 ${days}일 · 수집원 ${picked.length}곳` +
    (cats ? ` · 분류 ${cats.join(',')}` : '') +
    (terms.length ? ` · 키워드 ${terms.join(',')}` : ''),
);
console.log(`# 가져온 ${items.length}건 → 조건 통과 ${matched.length}건 → 출력 ${shown.length}건`);
// 🔴 실패한 곳을 **반드시 같이 찍는다.** 안 찍으면 "그 소식이 없었다"와 "그 소스를 못 봤다"가 같아진다.
if (failed.length) console.log(`# ⚠ 못 읽은 수집원 ${failed.length}곳: ${failed.map((f) => `${f.id}(${f.why})`).join(' · ')}`);
else console.log('# ✅ 모든 수집원 정상');
console.log('');

for (const i of shown) {
  console.log(`${i.date ?? '날짜미상'} [${i.category}] ${i.title}`);
  if (i.summary) console.log(`    ${i.summary.replace(/\s+/g, ' ').slice(0, 200)}`);
  console.log(`    ${i.url}`);
}
