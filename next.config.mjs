/** @type {import('next').NextConfig} */
const nextConfig = {
  // 서버 전용 패키지는 번들링하지 않고 런타임 require로 넘긴다(postgres·Sentry의 node 내장 의존).
  serverExternalPackages: ['postgres', '@sentry/node'],
};

export default nextConfig;
