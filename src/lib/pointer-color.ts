// 가리키기 색 (CALL-08 레이저 포인터·CALL-09 정지 화면 그리기·CALL-14 AR 핀·화살표).
// globals.css의 --color-pointer-live(= --color-red-500)·--color-pointer-halo(= --color-gray-0)와 같은 값.
// 캔버스에 그리는 곳(freeze-canvas, tracking/overlay.ts)은 CSS 변수를 못 읽어서 여기 옮겨 적는다.
// overlay.ts는 DOM을 보지 않는 순수 계산이라 getComputedStyle도 쓸 수 없다. 바꾸려면 요구사항부터, 두 곳을 같이 고칠 것

/** 빨강 — globals.css --color-red-500 */
export const POINTER_LIVE = "#e5484d";
/** 흰 테두리 — globals.css --color-gray-0 */
export const POINTER_HALO = "#ffffff";
