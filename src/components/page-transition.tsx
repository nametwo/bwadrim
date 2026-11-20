import { ViewTransition, type ReactNode } from "react";

// 앱처럼 (NFR-12): 엔지니어 화면을 넘길 때 앱처럼 옆으로 밀려 들어온다.
// 상담 목록에서 들어가는 링크는 nav-forward(오른쪽에서 들어옴), '상담 목록'으로 돌아가는 링크는 nav-back(왼쪽에서 들어옴).
// 종류가 없는 넘김(폰의 뒤로가기, 새로고침, 서버 액션 뒤 이동, 화면 안 갱신)은 움직이지 않는다 — 통화 화면이 갱신될 때 흔들리지 않게.
// 움직임은 globals.css의 ::view-transition-*(.nav-forward / .nav-back)
export const NAV_FORWARD = ["nav-forward"];
export const NAV_BACK = ["nav-back"];

const BY_TYPE = { "nav-forward": "nav-forward", "nav-back": "nav-back", default: "none" };

export function PageTransition({ children }: { children: ReactNode }) {
  return (
    <ViewTransition enter={BY_TYPE} exit={BY_TYPE} default="none">
      {children}
    </ViewTransition>
  );
}
