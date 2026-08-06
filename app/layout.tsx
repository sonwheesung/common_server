import './globals.css';

export const metadata = {
  title: '공통 서버',
  description: '여러 앱이 공유하는 공지사항·문의 백엔드',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
