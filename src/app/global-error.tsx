"use client";

// 최상위 레이아웃까지 실패했을 때 (BUG-13). 전역 스타일이 없으므로 인라인 스타일만 쓴다
export default function GlobalError({ retry }: { retry: () => void }) {
  return (
    <html lang="ko">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif',
          wordBreak: "keep-all",
          background: "#fff",
          color: "#161a20", // text-primary
          textAlign: "center",
          padding: "0 32px",
        }}
      >
        <title>봐드림</title>
        <h1 style={{ fontSize: 26, fontWeight: 700 }}>잠깐 문제가 생겼어요</h1>
        <p style={{ fontSize: 18, color: "#515a68" /* text-secondary */ }}>
          조금 있다가 다시 눌러 주세요.
        </p>
        <button
          onClick={() => retry()}
          style={{
            height: 64,
            padding: "0 40px",
            borderRadius: 16,
            border: 0,
            background: "#2456e6", // primary — 전역 CSS가 없어 토큰을 못 쓴다
            color: "#fff",
            fontSize: 20,
            fontWeight: 700,
          }}
        >
          다시 시도
        </button>
      </body>
    </html>
  );
}
