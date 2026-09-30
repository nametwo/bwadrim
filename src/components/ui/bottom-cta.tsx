import type { ReactNode } from "react";

// 화면 아래에 붙는 누를 곳 — 엄지가 닿는 자리. 스크롤해도 아래에 붙어 있고, 위쪽 가장자리는 배경색으로 흐려져
// 글자가 버튼 뒤에서 뚝 끊겨 보이지 않는다. 쓰는 쪽 화면은 좌우 여백이 px-5여야 한다(가장자리까지 채우려고 -mx-5).
// bg: 화면 바탕색에 맞춘다(흰 화면 page, 회색 화면 muted)
// 글을 치는 동안(입력칸에 커서)은 붙이지 않고 입력칸 아래로 흘려보낸다. 안드로이드 카톡 같은 앱 안 브라우저는
// 키보드만큼 화면이 줄어서, 붙어 있으면 키보드 바로 위로 올라와 입력칸을 가린다 (BUG-21)
export function BottomCta({ children, bg = "page" }: { children: ReactNode; bg?: "page" | "muted" }) {
  return (
    <div
      className={`sticky bottom-0 z-10 -mx-5 mt-auto flex flex-col gap-2 bg-gradient-to-t to-transparent px-5 pt-6 pb-[max(16px,env(safe-area-inset-bottom))] [body:has(:is(input:not([type=checkbox],[type=radio]),textarea):focus)_&]:static ${
        bg === "muted" ? "from-bg-muted from-75%" : "from-bg-page from-75%"
      }`}
    >
      {children}
    </div>
  );
}
