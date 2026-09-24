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
          fontFamily: "sans-serif",
          background: "#fff",
          color: "#171717",
          textAlign: "center",
          padding: "0 32px",
        }}
      >
        <title>봐드림</title>
        <h1 style={{ fontSize: 24 }}>잠시 문제가 생겼어요</h1>
        <p style={{ fontSize: 18, color: "#4b5563" }}>
          잠시 후 다시 시도해 주세요.
        </p>
        <button
          onClick={() => retry()}
          style={{
            height: 56,
            padding: "0 32px",
            borderRadius: 12,
            border: 0,
            background: "#000",
            color: "#fff",
            fontSize: 18,
          }}
        >
          다시 시도
        </button>
      </body>
    </html>
  );
}
