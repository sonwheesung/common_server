/** @type {import('next').NextConfig} */
const nextConfig = {
  // 서버 전용 패키지는 번들링하지 않고 런타임 require로 넘긴다(postgres·Sentry의 node 내장 의존).
  serverExternalPackages: ['postgres', '@sentry/node'],

  async headers() {
    return [
      {
        // ── CORS: 공개 API에만 ──
        //
        // 왜 필요한가: 앱을 웹(`expo start --web`)에서 띄우면 브라우저가 preflight를 보낸다.
        // 헤더가 없으면 요청이 서버에 닿기도 전에 차단돼 "서버 연동이 안 되는 것처럼" 보인다.
        // 네이티브(iOS/Android)는 CORS 대상이 아니라 출시 앱에는 영향이 없다 — 개발·웹 빌드용이다.
        //
        // 왜 `*` 가 안전한가: 이 두 엔드포인트는 쿠키·세션·Authorization을 일절 쓰지 않는
        // 완전 공개 API다. CORS가 막아주는 건 "브라우저가 자동으로 붙이는 자격증명을 남의 사이트가
        // 빌려 쓰는 것"인데 여기엔 빌려 쓸 자격증명이 없고, 이미 누구나 curl로 호출할 수 있다.
        // 남용(타 사이트가 방문자 브라우저로 문의를 대량 접수)은 CORS가 아니라 IP 레이트리밋과
        // 앱별 24h 캡이 막는다. `Access-Control-Allow-Credentials`는 **절대 켜지 않는다**.
        //
        // ⚠ `/api/admin/*` 에는 붙이지 않는다. 관리자 콘솔은 same-origin이라 필요가 없고,
        //   불필요하게 브라우저에서 교차출처 호출을 열어줄 이유가 없다.
        source: '/api/v1/:path*',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Access-Control-Allow-Methods', value: 'GET, POST, OPTIONS' },
          { key: 'Access-Control-Allow-Headers', value: 'content-type' },
          { key: 'Access-Control-Max-Age', value: '86400' }, // preflight 캐시 24h
        ],
      },
    ];
  },
};

export default nextConfig;
