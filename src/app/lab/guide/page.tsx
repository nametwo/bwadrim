import type { Metadata } from "next";
import { GuideLab } from "./guide-lab";

// 방향 지시 실험실(CALL-15) — 공개 페이지지만 검색엔진에 노출하지 않는다. 카메라·통화 없음.
export const metadata: Metadata = {
  title: "방향 지시 실험실 — 봐드림",
  robots: { index: false, follow: false, nocache: true },
};

export default function GuideLabPage() {
  return <GuideLab />;
}
