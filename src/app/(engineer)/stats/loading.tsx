import { PageSkeleton } from "@/components/page-skeleton";

// 통계를 세는 동안 바로 보이는 뼈대 (NFR-12)
export default function Loading() {
  return <PageSkeleton kind="list" />;
}
