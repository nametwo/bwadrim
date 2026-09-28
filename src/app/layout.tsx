import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ClientErrorReporter } from "@/components/client-error-reporter";

export const metadata: Metadata = {
  title: "봐드림",
  description: "문자 링크로 여는 원격 A/S. 폰 카메라로 비추면 기사님이 보고 알려 드려요.",
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
      <body className="min-h-full flex flex-col">
        <ClientErrorReporter />
        {children}
      </body>
    </html>
  );
}
