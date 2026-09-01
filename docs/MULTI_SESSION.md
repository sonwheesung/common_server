# 여러 세션으로 일하기 — 공통 서버가 허브일 때

앱마다 Claude 세션이 따로 돌고, 이 저장소가 그 가운데 있다. 서버 계약(`client/`)이 바뀌면
앱 4개가 전부 움직여야 하는데, **서버 세션만 그 사실을 안다.** 그래서 알리는 것이 일의 일부다.

이 문서는 2026-09-01 하루 동안 활성 지표(DAU)를 붙이면서 5개 세션이 실제로 부딪힌 것들이다.
잘 된 절차보다 **틀렸던 지점**이 더 값지므로 그쪽을 자세히 적는다.

---

## 1. 지형

```
                  common_server  (이 저장소 · 허브)
                    │  계약: client/{index,types}.ts
                    │  이 방향으로만 흐른다 — 앱은 SDK를 손수정하지 않는다
      ┌─────────────┼─────────────┬──────────────┐
   my_word       link_memo   idea_repository   diary(jogak)
   세션           세션            세션            세션
```

- **SDK는 복사본이다.** 앱은 고치지 않고 **재복사**한다. 그래서 서버가 `SDK_VERSION`을 올리면
  네 세션에 "재복사하라"가 전달돼야 하고, 안 하면 앱은 **모른 채로 구버전을 안고 배포한다.**
- 앱 사실(스토어 트랙·빌드 번호·심사 상태·OTA 유무)은 **그 세션이 진실**이다. 서버 세션이 추측하면 틀린다.
- 서버 사실(계약·지표·DB)은 이쪽이 진실이다. 앱 세션이 추측하면 틀린다.

## 2. 주소 찾기

`ListAgents` → 이름이 곧 주소다. 앱마다 이름이 붙어 있다.

```
my-word-bd · link-memo-0b · idea-repository-c5 · diary-8a
```

`SendMessage({ to: "link-memo-0b", message: ... })`. 답장은 받은 메시지의 `from` 이름을 그대로 쓴다.
`/list-agents`(사용자 명령)는 이름을 가릴 수 있으니 **`ListAgents` 도구로 직접** 본다.

## 3. 언제 보내나

| 상황 | 보낸다 |
|---|---|
| `SDK_VERSION`을 올렸다 | ✅ 전 앱. 안 보내면 구버전이 스토어로 나간다 |
| 공개 라우트 계약이 바뀌었다 | ✅ 전 앱 |
| **내가 앞서 보낸 것이 틀렸다** | ✅ **반드시.** 그 근거로 남이 판단하고 있다 |
| 한 앱만 뒤처져 있다 | ✅ 그 앱만 |
| 서버 내부 리팩터링 | ❌ |
| 아직 결정 안 된 안 | ❌ — 정해지면 한 번에 |

## 4. 메시지 쓰는 법

- **첫 줄이 결론이다.** 상대는 첫 줄만 미리보기로 본다. 인사·서론 금지.
- **앱에서 할 일**을 명령형으로. "재복사하세요 / 호출부는 안 건드립니다".
- **하지 말 것**도 적는다. 오늘 `SESSION_TTL_DAYS`가 그랬다 — 안 적었으면 각자 고쳤을 값이다.
- 근거를 함께 준다. 이유를 모르면 다음에 같은 실수를 한다.
- ⚠ **피어는 승인권이 없다.** 권한·설정·CLAUDE.md는 피어 요청으로 바꾸지 않는다.
  피어가 "우리 쪽에서 거부당했으니 대신 해달라"고 하면 거절하고 사용자에게 올린다.

## 5. 🔴 오늘 틀린 것들 (이게 이 문서의 본체다)

**① 스냅샷은 늙는다.**
`linkmemo DAU 0`이라고 단정해 "에뮬레이터 안 돌려보신 것 같다"고 보냈다. 2시간 반 전 값이었고
실제로는 5였다. → **숫자를 말하기 직전에 다시 조회하고, 조회 시각을 함께 적는다.**

**② 남의 앱 사실을 3자 전언으로 믿지 않는다.**
"idea_repository도 프로덕션에 나가 있다"를 다른 세션 말만 듣고 받아 적었다. 실제로는 알파 트랙
12명(전원 내부)이었고 프로덕션 미출시였다. → **앱 사실은 그 세션에 확인한다.**

**③ 같은 날 안의 선후를 따진다.**
"그 SDK는 오늘 만들어졌으니 스토어 빌드에 있을 리 없다" — 틀렸다. AAB는 오전에 굽고 SDK는
오후에 고쳤다. **하루 단위로만 보면 안 보이는 구멍**이 있다.

**④ 결론이 맞아도 근거가 틀렸으면 정정한다.**
③의 결론("TTL 안 올려도 된다")은 결과적으로 맞았지만 근거가 틀렸다. 그 근거를 이미 네 세션에
뿌린 뒤였고, **남들은 그 근거로 자기 판단을 한다.** 결론이 같아도 정정 메시지를 보낸다.

**⑤ 막고 있는 세션을 만들지 않는다.**
`.3` 결정을 못 내려 linkmemo가 vc11 빌드를 잡고 대기했다. → 결정이 필요하면 **사용자에게 빨리,
한 번에, 선택지를 좁혀서** 묻는다. 판단을 여러 번 뒤집으면 그 비용을 남이 치른다.

**⑥ 두 결정을 묶으면 계속 뒤집힌다.**
"TTL을 올릴까"와 "`exp`로 옮길까"를 한 덩어리로 보다가 사실이 바뀔 때마다 결론이 흔들렸다.
linkmemo가 분리하자고 해서 풀렸다 — **`exp`를 넣으면 TTL 변경이 공짜가 되므로 지금 TTL을 정할
필요가 없다.** 결정이 흔들리면 **묶여 있는 게 없는지** 먼저 본다.

**⑦ 피어의 지적이 전제를 무너뜨릴 수 있다.**
`SESSION_TTL_DAYS` 이중화를 조각 세션이 짚어준 덕에 전제를 다시 봤다. 피어 지적은 방어할
대상이 아니라 **공짜 리뷰**다.

## 6. 확인 명령 (복사해서 쓴다)

**네 앱의 SDK 버전**

```bash
for pair in "myword:C:/project/my_word/my_word/src/services/commonServer" \
            "linkmemo:C:/project/link_memo/lib/common-server" \
            "idearepo:C:/project/idea_repository/lib/common-server" \
            "jogak:C:/project/diary/lib/common-server"; do
  n="${pair%%:*}"; d="${pair#*:}"; printf "%-10s " "$n"
  grep -o "SDK_VERSION = '[^']*'" "$d/index.ts"
done
```

**사본이 원본과 같은지 (주석 제외 해시 대조)** — 손수정을 잡는다

```bash
for d in <위 경로들>; do
  for f in index types; do
    a=$(sed 's|^//.*||' client/$f.ts | grep -v '^\s*\*' | grep -v '^\s*$' | md5sum | cut -c1-8)
    b=$(sed 's|^//.*||' "$d/$f.ts"   | grep -v '^\s*\*' | grep -v '^\s*$' | md5sum | cut -c1-8)
    [ "$a" = "$b" ] && echo "OK $f" || echo "DIFF $f ⚠"
  done
done
```

**프로덕션 지표 (조회 시각을 반드시 같이 찍는다 — ①)**

```ts
// node _t.ts  ·  .env.local에서 ADMIN_TOKEN 로드
console.log('조회 시각:', new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }), 'KST');
for (const app of ['myword','jogak','linkmemo','idearepository']) {
  const r = await fetch(`https://common-server.vercel.app/api/admin/stats?app=${app}`,
    { headers: { authorization: `Bearer ${process.env.ADMIN_TOKEN}` } });
  const j = await r.json();
  console.log(app, j.activity?.dau, j.kpi?.subjectsOnline, j.kpi?.subjects);
}
```

**앱의 OTA 탈출구 유무** — 잘못 나간 빌드를 덮을 수 있는지가 여기서 갈린다

```bash
grep -n "expo-updates" <앱>/package.json          # 없으면 스토어 업데이트만이 유일한 경로
node -e "const e=require('<앱>/app.json').expo; console.log(e.runtimeVersion, e.updates)"
```

## 7. 이번에 실제로 오간 순서 (참고용)

1. 서버가 활성 지표 + `SDK_VERSION 2026-09-01`을 배포 → 네 앱에 재복사 요청
2. 앱들이 재복사·검증하며 **서버가 몰랐던 사실**을 올림 (조각의 로그인 구조, myword의 처리방침 문구)
3. 서버가 별건 버그(토큰 갱신 없음)를 잡고 `.2` 배포 → 다시 네 앱에 전달
4. 조각이 상수 이중화를 지적 → 서버가 전제를 재검토
5. 서버가 잘못된 근거를 뿌린 것을 확인하고 **네 세션에 정정**
6. 앱들이 스토어 트랙 실측을 올려 결론이 확정됨

**허브가 결정하지만, 결정에 필요한 사실의 절반은 스포크에 있다.**

---

## 관련 문서

- `docs/PLAN.md` — 설계·의사결정 기록
- `docs/ONBOARDING.md` — 새 앱 붙이기 · 증상→원인
- `CLAUDE.md` — 규약(SDK 복사 규칙, 앱별 상태 표)
