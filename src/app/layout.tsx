import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "봐드림",
  description: "설치 없이 링크 하나로, 폰 카메라로 비춰주는 원격 A/S",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1, // 고객 화면에서 실수로 확대되는 것 방지
  viewportFit: "cover",
  colorScheme: "light", // 다크 모드 폰에서도 밝은 화면 (BUG-10)
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ko" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
