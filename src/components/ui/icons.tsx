import type { SVGProps } from "react";

// 화면 공용 아이콘. 이모지는 폰 기종마다 모양·크기가 달라 버튼에 쓰지 않는다.
// 피그마 디자인 시스템 Components → Icons(Icon/*)와 같은 그림이다: 24×24, 선 두께 2, 둥근 끝.
// 색은 글자색(currentColor)을 따른다. 크기는 className(size-6 등)으로.
// 피그마에 없는 것(손전등·마이크·지우개 등)은 같은 규칙으로 그렸다 — 피그마 Icons에도 같은 이름으로 있다.

type IconProps = SVGProps<SVGSVGElement>;

function Svg({ children, strokeWidth = 2, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

// ───────────── 피그마 Icon/* ─────────────

/** Icon/chevron-left */
export function ChevronLeftIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M15 18L9 12L15 6" />
    </Svg>
  );
}

/** Icon/chevron-right */
export function ChevronRightIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M9 18L15 12L9 6" />
    </Svg>
  );
}

/** Icon/x */
export function CloseIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M18 6L6 18M6 6L18 18" />
    </Svg>
  );
}

/** Icon/check */
export function CheckIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M20 6L9 17L4 12" />
    </Svg>
  );
}

/** Icon/plus */
export function PlusIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 5V19M5 12H19" />
    </Svg>
  );
}

/** Icon/arrow-right */
export function ArrowRightIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M5 12H19M12 19L19 12L12 5" />
    </Svg>
  );
}

/** Icon/freeze — 화면 멈춤 */
export function FreezeIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M18.5 5H5.5C4.12 5 3 6.12 3 7.5V16.5C3 17.88 4.12 19 5.5 19H18.5C19.88 19 21 17.88 21 16.5V7.5C21 6.12 19.88 5 18.5 5Z" />
      <path d="M10 9.5V14.5M14 9.5V14.5" />
    </Svg>
  );
}

/** Icon/play — 라이브로 */
export function PlayIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M7 4.5V19.5L19 12L7 4.5Z" />
    </Svg>
  );
}

/** Icon/camera */
export function CameraIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M14.5 4H9.5L7 7H4C3.47 7 2.96 7.21 2.59 7.59C2.21 7.96 2 8.47 2 9V18C2 18.53 2.21 19.04 2.59 19.41C2.96 19.79 3.47 20 4 20H20C20.53 20 21.04 19.79 21.41 19.41C21.79 19.04 22 18.53 22 18V9C22 8.47 21.79 7.96 21.41 7.59C21.04 7.21 20.53 7 20 7H17L14.5 4Z" />
      <path d="M12 16.5C13.93 16.5 15.5 14.93 15.5 13C15.5 11.07 13.93 9.5 12 9.5C10.07 9.5 8.5 11.07 8.5 13C8.5 14.93 10.07 16.5 12 16.5Z" />
    </Svg>
  );
}

/** Icon/flip — 카메라 앞·뒤 바꾸기 */
export function FlipCameraIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 12C3 10.26 3.51 8.56 4.45 7.11C5.4 5.65 6.74 4.5 8.33 3.79C9.92 3.08 11.67 2.85 13.39 3.12C15.1 3.38 16.71 4.14 18 5.3L21 8" />
      <path d="M21 3V8H16" />
      <path d="M21 12C21 13.74 20.49 15.44 19.55 16.89C18.6 18.35 17.26 19.5 15.67 20.21C14.08 20.92 12.33 21.15 10.61 20.88C8.9 20.62 7.29 19.86 6 18.7L3 16" />
      <path d="M3 21V16H8" />
    </Svg>
  );
}

/** Icon/phone-end — 통화 종료 */
export function PhoneOffIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M1.45 15.59L-0.67 13.47C-0.87 13.27 -1.02 13.04 -1.13 12.78C-1.23 12.52 -1.27 12.24 -1.26 11.96C-1.25 11.69 -1.18 11.41 -1.06 11.16C-0.93 10.91 -0.76 10.69 -0.54 10.52C1.87 8.58 4.7 7.23 7.73 6.58C10.52 5.96 13.42 5.96 16.21 6.58C19.25 7.23 22.1 8.59 24.52 10.54C24.73 10.72 24.9 10.94 25.03 11.19C25.15 11.44 25.22 11.71 25.23 11.99C25.25 12.27 25.2 12.54 25.1 12.8C25 13.06 24.85 13.3 24.65 13.49L22.53 15.61C22.19 15.96 21.73 16.17 21.25 16.21C20.77 16.24 20.29 16.1 19.9 15.81C19.13 15.22 18.3 14.72 17.42 14.32C17.07 14.16 16.77 13.91 16.56 13.59C16.36 13.27 16.24 12.89 16.24 12.51V10.71C13.47 9.95 10.53 9.95 7.76 10.71V12.51C7.76 12.89 7.64 13.27 7.44 13.59C7.23 13.91 6.93 14.16 6.58 14.32C5.7 14.72 4.87 15.22 4.1 15.81C3.71 16.11 3.22 16.25 2.73 16.21C2.25 16.17 1.79 15.95 1.45 15.59Z" />
    </Svg>
  );
}

/** Icon/more — ⋯ */
export function MoreIcon(p: IconProps) {
  return (
    <Svg strokeWidth={3.2} {...p}>
      <path d="M5 12H5.01M12 12H12.01M19 12H19.01" />
    </Svg>
  );
}

/** Icon/link */
export function LinkIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M10 13C10.43 13.57 10.98 14.05 11.61 14.39C12.24 14.74 12.93 14.94 13.65 14.99C14.36 15.04 15.08 14.94 15.75 14.69C16.42 14.44 17.03 14.05 17.54 13.54L20.54 10.54C21.45 9.6 21.95 8.33 21.94 7.02C21.93 5.71 21.41 4.46 20.48 3.53C19.55 2.6 18.3 2.08 16.99 2.07C15.68 2.06 14.41 2.56 13.47 3.47L11.75 5.18" />
      <path d="M14 11C13.57 10.43 13.02 9.95 12.39 9.61C11.76 9.26 11.07 9.06 10.35 9.01C9.64 8.96 8.92 9.06 8.25 9.31C7.58 9.56 6.97 9.95 6.46 10.46L3.46 13.46C2.55 14.4 2.05 15.67 2.06 16.98C2.07 18.29 2.59 19.54 3.52 20.47C4.45 21.4 5.7 21.92 7.01 21.93C8.32 21.94 9.59 21.44 10.53 20.53L12.24 18.82" />
    </Svg>
  );
}

/** Icon/copy */
export function CopyIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M20 9H11C9.9 9 9 9.9 9 11V20C9 21.1 9.9 22 11 22H20C21.1 22 22 21.1 22 20V11C22 9.9 21.1 9 20 9Z" />
      <path d="M5 15H4C3.47 15 2.96 14.79 2.59 14.41C2.21 14.04 2 13.53 2 13V4C2 3.47 2.21 2.96 2.59 2.59C2.96 2.21 3.47 2 4 2H13C13.53 2 14.04 2.21 14.41 2.59C14.79 2.96 15 3.47 15 4V5" />
    </Svg>
  );
}

/** Icon/message — 문자 */
export function MessageIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M21 15C21 15.53 20.79 16.04 20.41 16.41C20.04 16.79 19.53 17 19 17H7L3 21V5C3 4.47 3.21 3.96 3.59 3.59C3.96 3.21 4.47 3 5 3H19C19.53 3 20.04 3.21 20.41 3.59C20.79 3.96 21 4.47 21 5V15Z" />
    </Svg>
  );
}

/** Icon/alert */
export function AlertIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M10.29 3.86L1.82 18C1.65 18.3 1.55 18.65 1.55 18.99C1.55 19.34 1.64 19.69 1.81 19.99C1.99 20.29 2.24 20.55 2.54 20.72C2.84 20.9 3.18 21 3.53 21H20.47C20.82 21 21.16 20.9 21.46 20.72C21.76 20.55 22.01 20.29 22.19 19.99C22.36 19.69 22.45 19.34 22.45 18.99C22.45 18.65 22.35 18.3 22.18 18L13.71 3.86C13.53 3.57 13.28 3.32 12.98 3.15C12.68 2.99 12.34 2.9 12 2.9C11.66 2.9 11.32 2.99 11.02 3.15C10.72 3.32 10.47 3.57 10.29 3.86Z" />
      <path d="M12 9V13M12 17H12.01" />
    </Svg>
  );
}

/** Icon/user */
export function UserIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M20 21V19C20 17.94 19.58 16.92 18.83 16.17C18.08 15.42 17.06 15 16 15H8C6.94 15 5.92 15.42 5.17 16.17C4.42 16.92 4 17.94 4 19V21" />
      <path d="M12 11C14.21 11 16 9.21 16 7C16 4.79 14.21 3 12 3C9.79 3 8 4.79 8 7C8 9.21 9.79 11 12 11Z" />
    </Svg>
  );
}

/** Icon/pen */
export function PencilIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 20H21" />
      <path d="M16.5 3.5C16.9 3.1 17.44 2.88 18 2.88C18.28 2.88 18.55 2.93 18.81 3.04C19.07 3.15 19.3 3.3 19.5 3.5C19.7 3.7 19.85 3.93 19.96 4.19C20.07 4.45 20.12 4.72 20.12 5C20.12 5.28 20.07 5.55 19.96 5.81C19.85 6.07 19.7 6.3 19.5 6.5L7 19L3 20L4 16L16.5 3.5Z" />
    </Svg>
  );
}

/** Icon/undo — 되돌리기 */
export function UndoIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 7V13H9" />
      <path d="M21 17C21 15.26 20.49 13.56 19.55 12.11C18.6 10.65 17.26 9.5 15.67 8.79C14.08 8.08 12.33 7.85 10.61 8.12C8.9 8.38 7.29 9.14 6 10.3L3 13" />
    </Svg>
  );
}

/** Icon/wifi — 연결 상태 */
export function WifiIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M5 12.55C6.98 10.9 9.47 10 12.04 10C14.61 10 17.1 10.9 19.08 12.55" />
      <path d="M1.42 9C4.34 6.42 8.1 5 12 5C15.9 5 19.66 6.42 22.58 9" />
      <path d="M8.53 16.11C9.55 15.39 10.76 15 12.01 15C13.25 15 14.46 15.39 15.48 16.11" />
      <path d="M12 20H12.01" />
    </Svg>
  );
}

/** Icon/clock */
export function ClockIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 21C16.97 21 21 16.97 21 12C21 7.03 16.97 3 12 3C7.03 3 3 7.03 3 12C3 16.97 7.03 21 12 21Z" />
      <path d="M12 7V12L15 14" />
    </Svg>
  );
}

/** Icon/external — 다른 브라우저로 열기 */
export function ExternalIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M18 13V19C18 19.53 17.79 20.04 17.41 20.41C17.04 20.79 16.53 21 16 21H5C4.47 21 3.96 20.79 3.59 20.41C3.21 20.04 3 19.53 3 19V8C3 7.47 3.21 6.96 3.59 6.59C3.96 6.21 4.47 6 5 6H11" />
      <path d="M15 3H21V9" />
      <path d="M10 14L21 3" />
    </Svg>
  );
}

/** Icon/lock */
export function LockIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M18 11H6C4.9 11 4 11.9 4 13V19C4 20.1 4.9 21 6 21H18C19.1 21 20 20.1 20 19V13C20 11.9 19.1 11 18 11Z" />
      <path d="M8 11V7C8 5.94 8.42 4.92 9.17 4.17C9.92 3.42 10.94 3 12 3C13.06 3 14.08 3.42 14.83 4.17C15.58 4.92 16 5.94 16 7V11" />
    </Svg>
  );
}

// ───────────── 코드에서 더한 것 (피그마 Icons에도 같은 이름) ─────────────

/** Icon/flashlight — 손전등 */
export function FlashlightIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M7 3H17V7L14.5 10.5V20C14.5 20.55 14.05 21 13.5 21H10.5C9.95 21 9.5 20.55 9.5 20V10.5L7 7V3Z" />
      <path d="M7 7H17M12 13V15" />
    </Svg>
  );
}

/** Icon/mic */
export function MicIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 3C10.34 3 9 4.34 9 6V11C9 12.66 10.34 14 12 14C13.66 14 15 12.66 15 11V6C15 4.34 13.66 3 12 3Z" />
      <path d="M19 11C19 14.87 15.87 18 12 18C8.13 18 5 14.87 5 11M12 18V21" />
    </Svg>
  );
}

/** Icon/mic-off */
export function MicOffIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M15 9.34V6C15 4.34 13.66 3 12 3C10.9 3 9.94 3.6 9.42 4.48M9 9V11C9 12.66 10.34 14 12 14C12.83 14 13.58 13.66 14.12 13.12" />
      <path d="M19 11C19 12.2 18.7 13.34 18.16 14.33M16.95 16.95C15.67 17.97 14.07 18 12 18C8.13 18 5 14.87 5 11M12 18V21M3 3L21 21" />
    </Svg>
  );
}

/** Icon/eraser — 모두 지우기 */
export function EraserIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M7 21L3.7 17.7C3.3 17.3 3.3 16.7 3.7 16.3L14.3 5.7C14.7 5.3 15.3 5.3 15.7 5.7L20.3 10.3C20.7 10.7 20.7 11.3 20.3 11.7L11 21" />
      <path d="M7 21H20M9 11L15 17" />
    </Svg>
  );
}

/** Icon/chart — 통계 */
export function ChartIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 20H20M7 16V12M12 16V7M17 16V10" />
    </Svg>
  );
}

/** Icon/logout */
export function LogoutIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M9 21H5C4.47 21 3.96 20.79 3.59 20.41C3.21 20.04 3 19.53 3 19V5C3 4.47 3.21 3.96 3.59 3.59C3.96 3.21 4.47 3 5 3H9" />
      <path d="M16 17L21 12L16 7M21 12H9" />
    </Svg>
  );
}

/** Icon/shield — 안심 */
export function ShieldIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 21C12 21 20 17 20 11V5L12 2L4 5V11C4 17 12 21 12 21Z" />
      <path d="M9 11.5L11 13.5L15 9.5" />
    </Svg>
  );
}

/** Icon/info */
export function InfoIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 21C16.97 21 21 16.97 21 12C21 7.03 16.97 3 12 3C7.03 3 3 7.03 3 12C3 16.97 7.03 21 12 21Z" />
      <path d="M12 16V11M12 8H12.01" />
    </Svg>
  );
}

/** Icon/refresh — 다시 시도·새로고침 */
export function RefreshIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M21 3V8H16" />
      <path d="M21 8L18.1 5.3C16.8 4.13 15.19 3.37 13.46 3.11C11.73 2.86 9.97 3.12 8.39 3.86C6.81 4.6 5.49 5.79 4.59 7.29C3.7 8.78 3.27 10.51 3.36 12.25" />
      <path d="M3 21V16H8" />
      <path d="M3 16L5.9 18.7C7.2 19.87 8.81 20.63 10.54 20.89C12.27 21.14 14.03 20.88 15.61 20.14C17.19 19.4 18.51 18.21 19.41 16.71C20.3 15.22 20.73 13.49 20.64 11.75" />
    </Svg>
  );
}

/** Icon/eye — 비밀번호 보기 */
export function EyeIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M2 12C2 12 5.5 5 12 5C18.5 5 22 12 22 12C22 12 18.5 19 12 19C5.5 19 2 12 2 12Z" />
      <path d="M12 15C13.66 15 15 13.66 15 12C15 10.34 13.66 9 12 9C10.34 9 9 10.34 9 12C9 13.66 10.34 15 12 15Z" />
    </Svg>
  );
}

/** Icon/eye-off — 비밀번호 숨기기 */
export function EyeOffIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M9.9 5.24C10.59 5.08 11.29 5 12 5C18.5 5 22 12 22 12C21.39 13.14 20.66 14.2 19.82 15.18M14.12 14.12C13.57 14.71 12.8 15.04 12 15C10.34 15 9 13.66 9 12C9 11.2 9.29 10.43 9.88 9.88M17.94 17.94C16.23 19.24 14.15 19.97 12 20C5.5 20 2 12 2 12C3.12 9.92 4.66 8.11 6.53 6.67" />
      <path d="M2 2L22 22" />
    </Svg>
  );
}

/** Icon/wifi-off — 연결 끊김 */
export function WifiOffIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M2 2L22 22" />
      <path d="M8.53 16.11C9.55 15.39 10.76 15 12.01 15C13.25 15 14.46 15.39 15.48 16.11M5 12.55C6.1 11.63 7.37 10.94 8.73 10.51M16.72 11.06C17.58 11.45 18.37 11.95 19.08 12.55M1.42 9C2.84 7.75 4.49 6.78 6.28 6.14M10.71 5.05C14.97 4.71 19.2 6.11 22.58 9M12 20H12.01" />
    </Svg>
  );
}

/** Icon/phone — 휴대폰 */
export function PhoneIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M17 2H7C5.9 2 5 2.9 5 4V20C5 21.1 5.9 22 7 22H17C18.1 22 19 21.1 19 20V4C19 2.9 18.1 2 17 2Z" />
      <path d="M12 18H12.01" />
    </Svg>
  );
}

/** Icon/tap — 여기를 누르세요 */
export function HandTapIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M9 11V5.5C9 4.67 9.67 4 10.5 4C11.33 4 12 4.67 12 5.5V11L12.2 9.7C12.3 8.9 13 8.3 13.8 8.4C14.6 8.5 15.2 9.2 15.2 10V11.5L15.3 10.9C15.4 10.1 16.2 9.6 17 9.8C17.8 10 18.3 10.7 18.3 11.5V15C18.3 18.3 15.6 21 12.3 21H11.5C9.7 21 8 20.2 6.9 18.8L4.3 15.6C3.8 14.9 3.9 14 4.6 13.5C5.2 13 6.1 13.1 6.6 13.7L9 16" />
    </Svg>
  );
}

/** Icon/volume — 소리 */
export function SpeakerIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M11 5L6 9H2V15H6L11 19V5Z" />
      <path d="M15.54 8.46C16.48 9.4 17 10.67 17 12C17 13.33 16.48 14.6 15.54 15.54M19.07 4.93C20.95 6.81 22 9.35 22 12C22 14.65 20.95 17.19 19.07 19.07" />
    </Svg>
  );
}

/** Icon/truck — 방문(출장) */
export function CarIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M16 3H1V16H16V3Z" />
      <path d="M16 8H20L23 11V16H16V8Z" />
      <path d="M5.5 21C6.88 21 8 19.88 8 18.5C8 17.12 6.88 16 5.5 16C4.12 16 3 17.12 3 18.5C3 19.88 4.12 21 5.5 21Z" />
      <path d="M18.5 21C19.88 21 21 19.88 21 18.5C21 17.12 19.88 16 18.5 16C17.12 16 16 17.12 16 18.5C16 19.88 17.12 21 18.5 21Z" />
    </Svg>
  );
}

/** Icon/check-circle — 끝났어요 */
export function CheckCircleIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 21C16.97 21 21 16.97 21 12C21 7.03 16.97 3 12 3C7.03 3 3 7.03 3 12C3 16.97 7.03 21 12 21Z" />
      <path d="M8 12.5L11 15.5L16 9.5" />
    </Svg>
  );
}

/** Icon/chat — 카톡 공유 (말풍선, 채움) */
export function ChatBubbleIcon(p: IconProps) {
  return (
    <Svg strokeWidth={0} {...p}>
      <path
        d="M12 4C7.3 4 3.5 7 3.5 10.7C3.5 13.1 5.1 15.2 7.5 16.4L6.7 19.4C6.6 19.8 7 20.1 7.3 19.9L10.9 17.5C11.3 17.5 11.6 17.6 12 17.6C16.7 17.6 20.5 14.6 20.5 10.8C20.5 7 16.7 4 12 4Z"
        fill="currentColor"
      />
    </Svg>
  );
}

/** 불러오는 중 — 피그마 Spinner(Tone=Light·Dark)와 같은 도는 고리 */
export function Spinner({ className = "size-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={`animate-spin ${className}`}>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
