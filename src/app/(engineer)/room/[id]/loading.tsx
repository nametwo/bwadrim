import { PageSkeleton } from "@/components/page-skeleton";

// 상담 화면을 서버가 그리는 동안 바로 보이는 뼈대 (NFR-12)
export default function Loading() {
  return <PageSkeleton kind="page" back="icon" />;
}
