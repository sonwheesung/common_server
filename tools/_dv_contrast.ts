// 색 대비 가드 — `app/globals.css`의 토큰을 **읽어서 계산한다**. 눈으로 판단하지 않는다.
//
// 🔴 **왜 이 파일이 생겼나** (2026-09-02):
// 2026-09-01에 "다크 primary 버튼이 AA 미달(3.70:1)"이라고 판단해 글자색을 근검정 → 근백으로
// 바꿨다(커밋 6ff4d9b). **그 숫자가 틀렸다.** 실제로는 근검정이 6.66:1로 통과였고, 근백이
// 2.64:1로 미달이었다 — 즉 멀쩡하던 것을 고친다며 **망가뜨렸다.**
// 계산을 한다고 말만 하고 손으로 적은 값이 커밋 메시지·주석·문서 세 곳에 그대로 퍼졌다.
//
// → 그래서 **주장을 못 하게** 만든다. 값은 CSS에서 읽고, 비율은 여기서 계산하고,
//   기준 미달이면 FAIL 한다. 다음에 누가 토큰을 만지면 그 자리에서 걸린다.
//
// 실행:  node tools/_dv_contrast.ts     (DB·서버 불필요)
export {};

import { readFileSync } from 'node:fs';

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

// ── OKLCH → 선형 sRGB → 감마 인코딩 → WCAG 상대휘도 ──
// 교과서 단계를 그대로 밟는다. 아래 오라클 절이 이 구현이 맞는지 **먼저** 증명한다.
function toLinear(L: number, C: number, H: number): [number, number, number] {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((v) => Math.min(1, Math.max(0, v)));
  return rgb as [number, number, number];
}
const encode = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const toHex = (c: [number, number, number]) =>
  '#' + toLinear(...c).map((v) => Math.round(encode(v) * 255).toString(16).padStart(2, '0')).join('');

function luminance(c: [number, number, number]): number {
  // 선형 RGB에서 바로 낸다. 감마 인코딩 → 다시 선형화는 왕복이라 결과가 같다(오라클이 확인한다).
  const [r, g, b] = toLinear(...c);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

// ── globals.css에서 토큰을 **읽는다** (손으로 옮겨 적지 않는다 — 그게 어제 사고의 절반이다) ──
const css = readFileSync('app/globals.css', 'utf8');
/** `:root { … }` / `:root[data-theme='dark'] { … }` 블록에서 oklch 토큰을 뽑는다. */
function tokens(darkMode: boolean): Record<string, [number, number, number]> {
  // 라이트는 `@theme { … }`(Tailwind v4 토큰 블록), 다크는 `:root[data-theme='dark'] { … }`.
  // ⚠ 블록 이름을 하드코딩하지 말고 **못 찾으면 실패**시킨다 — 조용히 빈 객체를 돌려주면
  //   아래 조합들이 전부 "토큰 없음"으로 스킵되면서 통과처럼 보인다.
  // ⚠ **주석에도 같은 문자열이 있다.** 처음 만든 판은 `indexOf(":root[data-theme='dark']")`로 찾다가
  //   파일 상단 주석("…적용한다(:root[data-theme='dark'])")을 먼저 잡았고, 거기서부터 잘라내니
  //   **라이트 토큰을 다크로 착각해** 다크 전 항목이 조용히 통과했다. 이 가드가 잡으려던 바로 그 종류다.
  //   → 선언부만 매치한다: 여는 중괄호가 뒤따르는 **줄 시작** 위치.
  const re = darkMode ? /^:root\[data-theme='dark'\]\s*\{/m : /^@theme\s*\{/m;
  const m = re.exec(css);
  if (!m) throw new Error(`블록을 못 찾음: ${re}`);
  const start = m.index;
  const block = css.slice(start, css.indexOf('\n}', start));
  const out: Record<string, [number, number, number]> = {};
  for (const m of block.matchAll(/--color-([\w-]+):\s*oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\)/g)) {
    out[m[1]] = [Number(m[2]) / 100, Number(m[3]), Number(m[4])];
  }
  return out;
}

console.log('[_dv_contrast] app/globals.css\n');

// ── ① 오라클 — 구현을 믿기 전에 아는 값으로 맞춘다 ──
// 🔴 이 절이 없으면 아래 전부가 "그럴듯한 숫자"일 뿐이다. 어제 정확히 그렇게 틀렸다.
{
  const white: [number, number, number] = [1, 0, 0];
  const black: [number, number, number] = [0, 0, 0];
  check('오라클: 흰색 vs 검정 = 21', ratio(white, black) === 21, String(ratio(white, black)));
  // 같은 색끼리는 항상 1 — 비율 공식이 뒤집히지 않는지 본다
  check('오라클: 같은 색끼리는 1', ratio([0.5, 0.1, 200], [0.5, 0.1, 200]) === 1);
  // 순서를 바꿔도 같은 값이어야 한다(대비는 방향이 없다)
  const a: [number, number, number] = [0.3, 0.1, 30];
  const b: [number, number, number] = [0.9, 0.05, 200];
  check('오라클: 순서를 바꿔도 같다', ratio(a, b) === ratio(b, a), `${ratio(a, b)} vs ${ratio(b, a)}`);
  // 밝을수록 검정과의 대비가 커진다 — 단조성이 깨지면 변환 어딘가가 뒤집힌 것이다
  const mono = [0.2, 0.4, 0.6, 0.8].map((L) => ratio([L, 0, 0], black));
  check('오라클: 밝을수록 검정 대비가 커진다', mono.every((v, i) => i === 0 || v > mono[i - 1]), mono.join(' < '));
  // 🔴 어제 틀린 그 값 — 밝은 파랑 위에서는 **검은 글씨가 흰 글씨보다 대비가 크다**.
  //    이 한 줄이 참이라는 걸 아는 것이 어제와 오늘을 가른다.
  const blue: [number, number, number] = [0.7, 0.16, 265];
  check(
    '오라클: 밝은 파랑(L70) 위에선 검은 글씨 > 흰 글씨',
    ratio([0.17, 0.02, 265], blue) > ratio([0.99, 0.01, 265], blue),
    `검정 ${ratio([0.17, 0.02, 265], blue)} vs 흰색 ${ratio([0.99, 0.01, 265], blue)}`,
  );
}

// ── ② 실제 조합 — 화면에서 정말 겹치는 쌍만 본다 ──
// AA: 작은 텍스트 4.5 · 큰 텍스트 3.0 · 비텍스트 UI(차트 막대·경계선) 3.0
const AA_TEXT = 4.5;
const AA_UI = 3.0;

for (const dark of [false, true]) {
  const t = tokens(dark);
  const mode = dark ? '다크' : '라이트';
  console.log(`\n  ── ${mode} ──`);

  const pairs: [string, string, string, number][] = [
    // [이름, 글자/전경 토큰, 배경 토큰, 기준]
    ['본문 텍스트', 'fg', dark ? 'surface' : 'surface', AA_TEXT],
    ['본문 텍스트 (페이지 배경 위)', 'fg', 'bg', AA_TEXT],
    ['보조 텍스트', 'fg-muted', 'surface', AA_TEXT],
    ['보조 텍스트 (페이지 배경 위)', 'fg-muted', 'bg', AA_TEXT],
    // 🔴 여기가 어제 틀린 자리다. primary 버튼 = bg-accent-strong + text-accent-fg
    ['primary 버튼 글자', 'accent-fg', 'accent-strong', AA_TEXT],
    ['primary 버튼 면 vs 카드', 'accent-strong', 'surface', AA_UI],
    ['accent 배지 글자', 'accent', 'accent-soft', AA_TEXT],
    ['danger 배지 글자', 'danger', 'danger-soft', AA_TEXT],
    ['warn 배지 글자', 'warn', 'warn-soft', AA_TEXT],
    ['ok 배지 글자', 'ok', 'ok-soft', AA_TEXT],
    // 비텍스트 — 차트 막대가 카드 면 위에서 보이는가
    ['차트 막대 vs 카드면', 'accent', 'surface', AA_UI],
  ];

  for (const [name, fgKey, bgKey, min] of pairs) {
    const fg = t[fgKey];
    const bg = t[bgKey];
    if (!fg || !bg) {
      check(`${mode} ${name}`, false, `토큰 없음(${fgKey}/${bgKey})`);
      continue;
    }
    const r = ratio(fg, bg);
    check(`${mode} ${name} ≥ ${min}`, r >= min, `${r}:1 (${toHex(fg)} on ${toHex(bg)})`);
  }
}

// ── ③ 🔴 레이어 밖 `color`가 유틸리티를 무력화하는가 (2026-09-02) ──────────────
// **이 가드의 가장 큰 구멍이었다.** 위 ②는 토큰 *값*을 계산한다 — 값이 맞아도 그 값을 쓰는
// **클래스가 안 먹으면** 화면은 여전히 틀린다. 실제로 그랬다:
//   `input,textarea,select,button { color: inherit }` 가 `@layer` **밖**에 있었고,
//   레이어 밖 스타일은 레이어 안(= Tailwind `@layer utilities`)을 **특이도와 무관하게 전부 이긴다.**
//   그래서 primary 버튼의 `text-accent-fg` 가 **한 번도 적용된 적이 없었다** —
//   배경만 파랗고 글자는 본문색(근검정)이었다. 사용자가 두 번 지적했고 나는 두 번 다
//   토큰을 고치고 "됐다"고 답했다. **오라클이 맞는 숫자를 틀린 대상에 대고 있었다.**
//
// ⚠ CSS 텍스트로 잡을 수 있는 건 여기까지다 — 실제 적용 여부는 브라우저에서만 알 수 있다.
//   그래서 **원인이 되는 패턴 자체**를 금지한다: 요소 선택자에 거는 `color` 는 반드시 레이어 안에.
{
  // `@layer ... { ... }` 블록을 통째로 들어낸 나머지 = 레이어 밖 CSS
  let unlayered = css;
  for (;;) {
    const m = /@layer[^{]*\{/.exec(unlayered);
    if (!m) break;
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < unlayered.length; i++) {
      if (unlayered[i] === '{') depth++;
      else if (unlayered[i] === '}' && --depth === 0) break;
    }
    unlayered = unlayered.slice(0, m.index) + unlayered.slice(i + 1);
  }

  // 레이어 밖에서 button/input 같은 **요소 선택자**에 color 를 거는 블록을 찾는다.
  const bad: string[] = [];
  for (const m of unlayered.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const sel = m[1].trim();
    const body = m[2];
    if (!/(^|[\s,(])(button|input|select|textarea)\b/.test(sel)) continue;
    if (!/(^|[;\s])color\s*:/.test(body)) continue;
    bad.push(sel.replace(/\s+/g, ' ').slice(0, 60));
  }
  check(
    '레이어 밖에서 button/input 에 color 를 걸지 않는다 (유틸리티를 무력화한다)',
    bad.length === 0,
    bad.join(' | '),
  );

  // 그 리셋이 **사라지지도** 않아야 한다 — 없으면 버튼 글자가 OS 기본색(buttontext)으로 돌아간다.
  check(
    'button color 리셋이 @layer base 안에 살아 있다',
    /@layer\s+base\s*\{[\s\S]*?button\s*\{[\s\S]*?color:\s*inherit/.test(css),
  );
}

// ── 🔴 가드가 줄어든 것을 잡는다 ──
// 조합을 지우면 그 조합은 실패가 아니라 **사라진다** — 오늘 하루 종일 나온 그 함정이다.
const MIN_CHECKS = 29; // 2026-09-02: accent-strong 2×테마 · 레이어 밖 color 2건
{
  const ran = pass + fail;
  if (ran < MIN_CHECKS) {
    fail++;
    console.log(`  FAIL  가드가 줄었다 — ${ran}개만 돌았다(최소 ${MIN_CHECKS}). 조합이 지워졌다`);
  }
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} — pass=${pass} fail=${fail} (실행 ${pass + fail} / 최소 ${MIN_CHECKS})`);
process.exit(fail === 0 ? 0 : 1);
