import type { NextConfig } from "next";

// 모든 응답에 붙는 보안 헤더 (NFR-11).
//  - 다른 사이트가 우리 화면을 iframe 안에 끼워 넣지 못하게 (클릭 가로채기)
//  - 브라우저가 파일 종류를 멋대로 짐작하지 않게
//  - 다른 사이트로 나갈 때 주소(고객 링크 토큰이 든 /join/… 등)를 넘기지 않게 — 같은 사이트 안에서는 그대로
// 카메라·마이크 허용 정책(Permissions-Policy)은 걸지 않는다 — 고객 화면이 카메라를 써야 한다
const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/(.*)", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
