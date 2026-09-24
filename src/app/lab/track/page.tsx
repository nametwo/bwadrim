import type { Metadata } from "next";
import { TrackLab } from "./track-lab";

// 추적 실험실 — 공개 페이지지만 검색엔진에 노출하지 않는다. 카메라는 버튼을 누른 뒤에만.
export const metadata: Metadata = {
  title: "추적 실험실 — 봐드림",
  robots: { index: false, follow: false, nocache: true },
};

type SearchParams = Record<string, string | string[] | undefined>;

function one(v: string | string[] | undefined): string | null {
  return typeof v === "string" ? v : Array.isArray(v) ? (v[0] ?? null) : null;
}

export default async function TrackLabPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const mode = one(sp.mode) === "single" ? "single" : "loopback";
  return (
    <TrackLab
      e2e={one(sp.e2e) === "1"}
      pane={one(sp.pane)}
      initialMode={mode}
      synthetic={one(sp.synthetic) === "blank" ? "blank" : null}
    />
  );
}
