import { UserIcon } from "./icons";

// 누가 기다리는지 — 피그마 Components → EngineerCard. 낯선 링크에 대한 불안을 줄인다.
// 제목 위에 한 줄로 가볍게 놓는다(상자로 감싸지 않음): 파란 원 사람 아이콘 + '김도현 기사님' + '이 기다리고 있어요'.
// 기사님 이름은 엔지니어 계정의 표시 이름(OPS-03)이다. 없으면 쓰는 쪽에서 빼거나 name 없이 부른다.
export function EngineerCard({ name, sub = "이 기다리고 있어요" }: { name?: string | null; sub?: string }) {
  return (
    <p className="flex items-center gap-2.5">
      <span className="grid size-10 flex-none place-items-center rounded-full bg-primary-tint text-icon-brand">
        <UserIcon className="size-5" />
      </span>
      <span className="min-w-0 text-body-l text-text-secondary">
        <b className="font-bold text-text-primary">{name ? `${name} 기사님` : "봐드림 기사님"}</b>
        {sub}
      </span>
    </p>
  );
}
