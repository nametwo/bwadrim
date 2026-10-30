// 서비스 주소 (OPS-07). 고객에게 보내는 링크와 카톡 카드 사진 주소를 늘 이 주소로 만든다.
// 비어 있으면 엔지니어가 지금 연 주소(요청 host)를 쓴다 — 로컬·미리보기 배포는 그대로 동작한다.
// 운영에는 NEXT_PUBLIC_SITE_URL=https://bwadrim.com 을 넣는다(OPS-01). 엔지니어가 예전 주소(vercel.app)나
// 그 주소로 설치한 홈 화면 앱에서 열어도 고객에게는 짧은 운영 주소가 간다.
// NEXT_PUBLIC_이라 빌드할 때 들어간다 — 넣거나 바꾸면 다시 배포한다
const raw = (process.env.NEXT_PUBLIC_SITE_URL ?? "").trim().replace(/\/+$/, "");

/** 'https://bwadrim.com' 꼴. 안 정했으면 null */
export const SITE_URL: string | null = /^https?:\/\/[^/\s]+$/.test(raw) ? raw : null;

// 값을 넣었는데 꼴이 달라 무시됐으면(예: 'bwadrim.com', 경로가 붙음) 서버 로그에 한 번 남긴다 — 아니면 안 넣은 것과 구별이 안 된다
if (raw && SITE_URL === null && typeof window === "undefined") {
  console.warn(`[site-url] NEXT_PUBLIC_SITE_URL을 무시했어요 (https://호스트 꼴이어야 함): ${raw}`);
}
