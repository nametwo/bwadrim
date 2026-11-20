// 앱처럼 (NFR-12): 엔지니어 화면을 누르면 서버가 그릴 때까지 기다리지 않고 바로 화면 뼈대를 보여 준다 (각 화면의 loading.tsx).
// 웹처럼 '눌렀는데 아무 일도 없다가 화면이 통째로 바뀌는' 틈을 없앤다. 글자 대신 회색 막대, 자리는 실제 화면과 같게
//  - list: 회색 바탕 + 흰 카드(상담 목록·통계)
//  - page: 흰 화면(상담·내 계정)
// 뒤로 버튼 자리는 막대가 아니라 실제 모양이라, 다 뜨기 전에 다시 눌러도 같은 자리다
import { ChevronLeftIcon } from "@/components/ui/icons";

function Bar({ className }: { className: string }) {
  return <span className={`block rounded-lg bg-border/70 ${className}`} />;
}

// back: 'label' = '‹ 상담 목록'(통계·내 계정), 'icon' = '‹'만(상담 화면 위쪽 바), false = 로고 자리(상담 목록)
// instant: 늦게 옅게 나타나지 않고 바로 보인다('새 A/S 시작'처럼 누른 즉시 들어오는 경우)
export function PageSkeleton({
  kind,
  back = "label",
  instant = false,
}: {
  kind: "list" | "page";
  back?: "label" | "icon" | false;
  instant?: boolean;
}) {
  const list = kind === "list";
  return (
    <div
      data-testid="page-skeleton"
      aria-busy="true"
      aria-label="불러오는 중"
      className={`flex min-h-dvh flex-col ${list ? "bg-bg-muted" : "bg-bg-page"}`}
    >
      <div className={`mx-auto flex w-full max-w-md flex-1 flex-col px-5 pt-[max(8px,env(safe-area-inset-top))] ${instant ? "" : "motion-safe:animate-[skeleton-in_400ms_ease-out_both]"}`}>
        <div className="flex min-h-14 items-center">
          {back === "icon" ? (
            <span className="-ml-2 grid size-touch place-items-center text-icon">
              <ChevronLeftIcon className="size-6" />
            </span>
          ) : back === "label" ? (
            <span className="-ml-2 flex h-touch items-center gap-0.5 pr-3 pl-1 text-label-m text-text-secondary">
              <ChevronLeftIcon className="size-6" />
              상담 목록
            </span>
          ) : (
            <Bar className="h-7 w-24" />
          )}
        </div>
        <div className="flex flex-col gap-2.5 pt-4 pb-6">
          <Bar className="h-8 w-48" />
          <Bar className="h-5 w-64" />
        </div>
        <div className="flex flex-col gap-3 motion-safe:animate-pulse">
          {[0, 1].map((i) => (
            <div key={i} className={`flex flex-col gap-4 rounded-3xl px-5 py-5 ${list ? "bg-bg-page" : "bg-bg-subtle"}`}>
              <Bar className="h-5 w-28" />
              <Bar className="h-5 w-full" />
              <Bar className="h-5 w-3/4" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
