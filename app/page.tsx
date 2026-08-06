// 루트는 의도적으로 비워 둔다 — 이 배포는 앱들이 쓰는 API 서버이고, 사람이 볼 화면은 관리자 콘솔뿐이다.
// 관리자 경로는 여기에 링크하지 않는다(크롤링 노출 축소. 실제 방어는 ADMIN_TOKEN fail-closed).
export default function Home() {
  return (
    <main className="grid min-h-dvh place-items-center p-10">
      <div className="text-center">
        <h1 className="text-base font-semibold tracking-tight">common server</h1>
        <p className="mt-1 text-sm text-(--color-fg-muted)">API only.</p>
      </div>
    </main>
  );
}
