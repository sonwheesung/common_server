// 루트는 의도적으로 비워 둔다 — 이 배포는 앱들이 쓰는 API 서버이고, 사람이 볼 화면은 관리자 콘솔뿐이다.
// 관리자 경로는 여기에 링크하지 않는다(크롤링 노출 축소. 실제 방어는 ADMIN_TOKEN fail-closed).
export default function Home() {
  return (
    <main style={{ padding: 40, color: '#555' }}>
      <h1 style={{ fontSize: 18, fontWeight: 600 }}>common server</h1>
      <p style={{ fontSize: 14 }}>API only.</p>
    </main>
  );
}
