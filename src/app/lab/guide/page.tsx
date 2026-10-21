import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { GuideLab } from "./guide-lab";

// 방향 지시 실험실(CALL-15) — 개발자가 통화 없이 방향 지시를 흉내 내 보는 곳. 카메라·통화 없음.
// 쓰는 사람이 개발자뿐이라 운영 주소(bwadrim.com)에서는 열지 않는다(없는 주소와 같은 화면).
// 로컬과 미리보기 배포에서만 열리고, 검색엔진에도 노출하지 않는다
export const metadata: Metadata = {
  title: "방향 지시 실험실 — 봐드림",
  robots: { index: false, follow: false, nocache: true },
};

export default function GuideLabPage() {
  if (process.env.VERCEL_ENV === "production") notFound();
  return <GuideLab />;
}
