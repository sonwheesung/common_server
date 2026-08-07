import type { Metadata } from 'next';
import { Noto_Sans_KR } from 'next/font/google';
import './globals.css';

// Windows 기본 한글 폰트(맑은 고딕)는 UI에 쓰기엔 자간·굵기가 거칠다.
// Noto Sans KR은 한글 UI용으로 설계됐고 굵기 단계가 촘촘해 위계를 만들기 쉽다.
// display:swap — 폰트 로딩이 화면을 막지 않게(운영 화면은 빨리 떠야 한다).
const sans = Noto_Sans_KR({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
  variable: '--font-sans',
});

export const metadata: Metadata = {
  title: '공통 서버',
  description: '여러 앱이 공유하는 공지사항·문의 백엔드',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" className={sans.variable}>
      <head>
        {/*
          테마를 **하이드레이션 전에** 적용한다. React가 붙은 뒤에 켜면 밝은 화면이 한 번 번쩍인 뒤
          어두워진다(FOUC). 저장된 값이 없으면 밝은 테마 — OS 다크를 따라가지 않는다.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('cs_theme');if(t==='dark')document.documentElement.dataset.theme='dark';}catch(e){}`,
          }}
        />
      </head>
      <body style={{ fontFamily: 'var(--font-sans), ui-sans-serif, system-ui, sans-serif' }}>{children}</body>
    </html>
  );
}
