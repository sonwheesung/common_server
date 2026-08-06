# Common Server API 계약

여러 앱(프로젝트)의 **공지사항**과 **문의하기**를 한 서버에서 처리한다.
이 문서가 서버·클라이언트 양쪽 구현의 단일 기준이며, 여기 없는 동작에 의존하면 안 된다.

- Base URL: `https://<deployment>`
- 모든 요청/응답은 `application/json; charset=utf-8`
- 공개 API는 **인증 없음 · 완전 익명**. 클라이언트는 계정·기기 식별자를 보내지 않는다.

## 설계 원칙

1. **프로젝트 격리** — 모든 조회/변경은 `proj` 로 스코프된다. `proj` 없는 관리자 쿼리는 존재하지 않는다.
2. **익명 유지** — 서버는 IP를 저장하지 않고, 기기·계정 식별자를 받지 않는다.
   문의 답변은 발급된 `accessKey` 를 클라이언트가 **로컬에만** 보관하고 되물어보는 방식으로 전달한다.
3. **존재 여부 비노출** — 잘못된 `id` 와 잘못된 `key` 는 **동일한 404** 를 돌려준다.
4. **클라이언트는 서버를 신뢰한다** — 정렬·만료 제외·개수 상한은 서버 책임이고, 클라이언트는 받은 순서를 그대로 쓴다.

## 공통 응답 형식

성공은 `ok: true`, 실패는 `ok: false` 와 기계가 읽는 `reason` 을 함께 준다.

```json
{ "ok": false, "reason": "not-found" }
```

| HTTP | reason | 의미 |
|------|--------|------|
| 400 | `bad-request` | 필수 필드 누락·형식 오류 |
| 400 | `too-short` | 문의 본문이 최소 길이 미만 |
| 401 | `unauthorized` | 관리자 토큰 없음/불일치 |
| 404 | `not-found` | 대상 없음, 또는 **`proj` 가 등록되지 않음** |
| 429 | `rate-limited` | 접수 한도 초과 |
| 500 | `error` | 서버 오류 |

---

# 1. 공개 API

## 1.1 공지 목록

```
GET /api/v1/notices?proj=<code>
```

**응답 200**

```json
{
  "ok": true,
  "notices": [
    {
      "id": "0f8b...uuid",
      "title": "1.0.1 업데이트 안내",
      "body": "문의 답변 확인 기능이 추가되었습니다.\n설정 > 내 문의 내역에서 확인하세요.",
      "level": "info",
      "publishedAt": "2026-08-06T00:00:00.000Z"
    }
  ]
}
```

| 필드 | 형 | 규약 |
|------|-----|------|
| `id` | uuid | **재사용 절대 금지.** 클라이언트가 읽음 처리 키로 쓰므로, 재사용하면 사용자가 못 본 공지가 읽음 처리된다 |
| `title` | string | ≤ 100자 |
| `body` | string | ≤ 4000자. **플레인 텍스트** — `\n` 만 줄바꿈으로 해석한다. 마크다운/HTML 미지원 |
| `level` | `"info"` \| `"important"` | `important` 는 클라이언트가 상단 고정·강조 |
| `publishedAt` | ISO-8601 UTC | |

**서버 책임**: `publishedAt DESC` 정렬, `enabled = true`, `publishedAt <= now`, `expiresAt IS NULL OR expiresAt > now` 인 것만, 최대 **50건**.

`proj` 미등록 시 404. 응답에 `Cache-Control: public, s-maxage=60, stale-while-revalidate=600`.

## 1.2 문의 접수

```
POST /api/v1/tickets
```

**요청**

```json
{
  "proj": "myword",
  "category": "bug",
  "content": "퀴즈에서 뒤로가기가 안 됩니다",
  "device": { "platform": "android", "appVersion": "1.0.0" }
}
```

| 필드 | 필수 | 규약 |
|------|------|------|
| `proj` | ✅ | 등록된 프로젝트 코드. 미등록 시 404 |
| `category` | ✅ | `bug` \| `suggestion` \| `question` \| `etc`. 그 외 값은 `etc` 로 저장 |
| `content` | ✅ | 5자 이상 2000자 이하. 초과분은 **서버가 자른다**(거부하지 않음) |
| `device.platform` | | `android` \| `ios` \| `web` — 진단용 |
| `device.appVersion` | | 진단용 |

**응답 200**

```json
{
  "ok": true,
  "ticketId": "3f2a...uuid",
  "accessKey": "kJ8x...43자 base64url"
}
```

> ⚠️ `accessKey` 는 **이 응답에서 단 한 번만** 내려간다. 서버는 해시만 보관하므로 재발급이 불가능하다.
> 클라이언트는 즉시 로컬에 저장해야 하며, 저장에 실패하면 그 문의의 답변은 영영 조회할 수 없다.

**한도**: 프로젝트별 24시간 접수 상한(기본 10건)을 넘으면 429. IP를 저장하지 않으므로 한도는 프로젝트 단위로만 적용된다.

## 1.3 내 문의 조회 (답변 확인)

```
GET /api/v1/tickets/{id}?key=<accessKey>
```

**응답 200**

```json
{
  "ok": true,
  "ticket": {
    "id": "3f2a...uuid",
    "category": "bug",
    "content": "퀴즈에서 뒤로가기가 안 됩니다",
    "status": "answered",
    "reply": "다음 업데이트에서 수정했습니다. 감사합니다.",
    "createdAt": "2026-08-06T01:00:00.000Z",
    "repliedAt": "2026-08-06T09:00:00.000Z"
  }
}
```

| `status` | 의미 |
|----------|------|
| `open` | 접수됨 (기본) |
| `reviewing` | 확인 중 |
| `answered` | 답변 완료 — `reply` 와 `repliedAt` 이 채워진다 |

`id` 가 없거나 `key` 가 틀리면 **둘 다 404 `not-found`** 로 응답한다(티켓 존재 여부를 노출하지 않기 위함).

---

# 2. 관리자 API

모든 관리자 엔드포인트는 헤더가 필요하다.

```
Authorization: Bearer <ADMIN_TOKEN>
```

`ADMIN_TOKEN` 미설정 또는 16자 미만이면 **모든 관리자 기능이 전면 차단된다**(fail-closed).
검증은 상수시간 비교로 수행한다.

> 🔴 **`proj` 는 프로젝트 목록 조회를 제외한 모든 엔드포인트에서 필수다.**
> 누락 시 400. 프로젝트 간 데이터가 섞이는 사고를 막는 가장 중요한 규약이다.

## 2.1 프로젝트

```
GET  /api/admin/projects                     → { ok, projects: [{ code, name, createdAt }] }
POST /api/admin/projects   { code, name }    → { ok }
```

`code` 는 소문자·숫자·하이픈만 허용(`^[a-z0-9-]{2,32}$`). 프로젝트는 관리자가 먼저 만들어야 하며,
문의·공지가 자동으로 프로젝트를 생성하지 않는다(스팸으로 임의 프로젝트가 생기는 것 방지).

## 2.2 문의

```
GET  /api/admin/tickets?proj=<code>&status=<optional>&limit=50&before=<ISO>
     → { ok, tickets: [{ id, category, content, status, reply, platform, appVersion, createdAt, repliedAt }] }

POST /api/admin/tickets/reply
     { proj, ticketId, reply?, status? }
     → { ok }
```

- 목록은 `createdAt DESC`, 커서는 `before`(그 시각보다 이전 것). 기본 50건, 최대 100건
- `reply` 는 ≤ 4000자. `reply` 를 주고 `status` 를 생략하면 `answered` 로 자동 전이
- 업데이트는 `proj + ticketId` 두 조건으로 수행하고, **변경된 행이 0이면 404** 를 준다
  (다른 프로젝트의 티켓에 답변이 박히는 것을 막고, 운영자가 "답변 완료"로 오인하지 않게 한다)
- `accessKey` 해시는 어떤 관리자 응답에도 포함되지 않는다

## 2.3 공지

```
GET    /api/admin/notices?proj=<code>
       → { ok, notices: [{ id, title, body, level, enabled, publishedAt, expiresAt, createdAt }] }

POST   /api/admin/notices    { proj, title, body, level?, publishedAt?, expiresAt?, enabled? }  → { ok, id }
PATCH  /api/admin/notices    { proj, id, ...변경할 필드 }                                        → { ok }
DELETE /api/admin/notices?proj=<code>&id=<uuid>                                                  → { ok }
```

- 관리자 목록은 **비활성·예약·만료 공지까지 전부** 반환한다(공개 API와 다름)
- `publishedAt` 미지정 시 현재 시각. 미래로 두면 예약 게시
- `level` 기본 `info`, `enabled` 기본 `true`

---

# 3. 클라이언트 구현 규약

1. **공지 조회 실패는 완전 무음** — 서버가 죽어도 앱의 기존 동작에 어떤 영향도 없어야 한다.
   실패 시 마지막 캐시를 쓰고, 캐시도 없으면 빈 상태를 보여준다.
2. **읽음 상태는 로컬 저장** — 서버에 읽음을 보내지 않는다(익명 유지).
3. **콜드스타트 방어** — 읽음 목록이 아예 없는 최초 실행에서는 내려온 공지를 **전부 읽음 처리**한다.
   이를 생략하면 기존 사용자 전원에게 과거 공지가 안읽음으로 쏟아진다.
4. **`accessKey` 는 로컬 전용** — 로그·분석·공유 대상에 절대 포함하지 않는다.
5. **답변 폴링은 미해결 티켓만** — `status`가 `answered` 인 티켓은 더 조회하지 않는다.

# 4. 환경변수

| 변수 | 필수 | 설명 |
|------|------|------|
| `DATABASE_URL` | ✅ | Postgres 연결 문자열. Supabase 사용 시 트랜잭션 풀러(:6543) |
| `ADMIN_TOKEN` | ✅ | 관리자 Bearer 토큰. **16자 미만이면 관리자 기능 전면 차단** |
| `TICKET_DAILY_CAP` | | 프로젝트별 24시간 접수 상한. 기본 `10` |
| `DISCORD_WEBHOOK_URL` | | 문의 접수 알림 기본 웹훅 |
| `DISCORD_WEBHOOK_URL_<PROJ>` | | 프로젝트별 웹훅(대문자·하이픈→언더스코어). 있으면 우선 |
