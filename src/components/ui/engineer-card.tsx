import { UserIcon } from "./icons";

// 누가 기다리는지 보여 주는 카드 — 피그마 Components → EngineerCard. 낯선 링크에 대한 불안을 줄인다.
// 기사님 이름은 엔지니어 계정의 표시 이름(OPS-03)이다. 없으면 쓰는 쪽에서 카드를 빼거나 name 없이 부른다.
export function EngineerCard({ name, sub = "봐드림 원격 A/S" }: { name?: string | null; sub?: string }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-bg-subtle px-4 py-3">
      <span className="grid size-11 flex-none place-items-center rounded-full bg-bg-page text-icon-secondary">
        <UserIcon className="size-[22px]" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-label-l text-text-primary">{name ? `${name} 기사님` : "봐드림 기사님"}</span>
        <span className="text-body-s text-text-secondary">{sub}</span>
      </span>
    </div>
  );
}
