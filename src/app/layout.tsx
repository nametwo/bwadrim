import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "봐드림",
  description: "문자 링크로 여는 원격 A/S. 폰 카메라로 비추면 기사님이 보고 알려 드려요.",
  // 영어로 맞춘 폰에서 크롬이 '번역할까요?'를 띄우지 않게 (NFR-12). 안드로이드 크롬은 html의 translate="no"만으로는
  // 계속 띄워서(2026-11-20 에뮬레이터 크롬 133) 구글이 읽는 이 메타를 같이 둔다
  other: { google: "notranslate" },
};

// 앱처럼 (NFR-12): 링크·사진을 꾹 누르면 크롬이 띄우는 메뉴('새 탭에서 열기'·'링크 다운로드' 등)를 막는다.
// 안드로이드는 CSS(-webkit-touch-callout)를 무시해서 스크립트로 막는다. 입력칸과 복사하라고 둔 글(select-text·select-all)은 그대로
const NO_LONG_PRESS_MENU = `document.addEventListener('contextmenu',function(e){var t=e.target;if(t&&t.closest&&t.closest('input,textarea,[contenteditable="true"],.select-text,.select-all'))return;e.preventDefault();});`;

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1, // 고객 화면에서 실수로 확대되는 것 방지
  viewportFit: "cover",
  colorScheme: "light", // 다크 모드 폰에서도 밝은 화면 (BUG-10)
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // translate="no": 영어로 맞춘 폰에서 크롬이 '번역할까요?'를 띄우지 않게 (NFR-12)
    <html lang="ko" translate="no" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <script dangerouslySetInnerHTML={{ __html: NO_LONG_PRESS_MENU }} />
        {children}
      </body>
    </html>
  );
}
