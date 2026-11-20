import { PageTransition } from "@/components/page-transition";

// 화면을 옮길 때마다 새로 붙는 틀 — 그래야 넘김 효과가 들어오고 나간다 (NFR-12)
export default function EngineerTemplate({ children }: { children: React.ReactNode }) {
  return <PageTransition>{children}</PageTransition>;
}
