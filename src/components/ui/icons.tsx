import type { SVGProps } from "react";

// 화면 공용 아이콘. 이모지는 폰 기종마다 모양·크기가 달라 버튼에 쓰지 않는다.
// 24×24 선 아이콘, 색은 글자색(currentColor)을 따른다. 크기는 className(size-6 등)으로.

type IconProps = SVGProps<SVGSVGElement>;

function Svg({ children, strokeWidth = 2.2, ...props }: IconProps) {
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

export function CameraIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h8A2.5 2.5 0 0 1 16 8.5v7a2.5 2.5 0 0 1-2.5 2.5h-8A2.5 2.5 0 0 1 3 15.5z" />
      <path d="m16 10.5 4.2-2.6a.5.5 0 0 1 .8.4v7.4a.5.5 0 0 1-.8.4L16 13.5" />
    </Svg>
  );
}

export function FlipCameraIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 9.5A2.5 2.5 0 0 1 6.5 7h1.3l1.4-2h5.6l1.4 2h1.3A2.5 2.5 0 0 1 20 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5z" />
      <path d="M9 12.5a3 3 0 0 1 5.2-1.6M15 14.5a3 3 0 0 1-5.2 1.6" />
      <path d="M14.6 9.4v1.8h-1.8M9.4 17.6v-1.8h1.8" />
    </Svg>
  );
}

export function FlashlightIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M7 3h10v4l-2.5 3.5V20a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-9.5L7 7z" />
      <path d="M7 7h10M12 13v2" />
    </Svg>
  );
}

export function PencilIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 20l1-4.2L15.6 5.2a2 2 0 0 1 2.8 0l.4.4a2 2 0 0 1 0 2.8L8.2 19z" />
      <path d="M13.5 7.3l3.2 3.2" />
    </Svg>
  );
}

export function PlayIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M8 5.5v13a.8.8 0 0 0 1.2.7l10.3-6.5a.8.8 0 0 0 0-1.4L9.2 4.8A.8.8 0 0 0 8 5.5z" fill="currentColor" />
    </Svg>
  );
}

export function UndoIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </Svg>
  );
}

export function EraserIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="m7 21-3.3-3.3a1.5 1.5 0 0 1 0-2.1L14.6 4.7a1.5 1.5 0 0 1 2.1 0l3.6 3.6a1.5 1.5 0 0 1 0 2.1L10.8 20" />
      <path d="M7 21h13M9 10.5l5.5 5.5" />
    </Svg>
  );
}

export function PhoneOffIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3.6 14.2c-.6-.6-.6-1.7.1-2.3C6 9.9 8.9 9 12 9s6 .9 8.3 2.9c.7.6.7 1.7.1 2.3l-1.5 1.5c-.5.5-1.3.6-1.9.2l-1.8-1.2a1.5 1.5 0 0 1-.7-1.3v-1.2c-1.6-.5-3.4-.5-5 0v1.2c0 .5-.3 1-.7 1.3l-1.8 1.2c-.6.4-1.4.3-1.9-.2z" />
    </Svg>
  );
}

export function MicIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
    </Svg>
  );
}

export function MicOffIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M15 10V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 4.6 2.5" />
      <path d="M18.5 11a6.5 6.5 0 0 1-1.1 3.6M5.5 11a6.5 6.5 0 0 0 10 5.5M12 17.5V21M4 4l16 16" />
    </Svg>
  );
}

export function MessageIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.2a.5.5 0 0 1-.8-.4V17h0a1 1 0 0 1-1-1z" />
      <path d="M8 9h8M8 12.5h5" />
    </Svg>
  );
}

export function ChatBubbleIcon(p: IconProps) {
  return (
    <Svg {...p} strokeWidth={0}>
      <path
        d="M12 4c-4.7 0-8.5 3-8.5 6.7 0 2.4 1.6 4.5 4 5.7l-.8 3c-.1.4.3.7.6.5l3.6-2.4c.4 0 .7.1 1.1.1 4.7 0 8.5-3 8.5-6.8S16.7 4 12 4z"
        fill="currentColor"
      />
    </Svg>
  );
}

export function LinkIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </Svg>
  );
}

export function CopyIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2.5" />
      <path d="M15.5 8.5V6.5A2.5 2.5 0 0 0 13 4H6.5A2.5 2.5 0 0 0 4 6.5V13a2.5 2.5 0 0 0 2.5 2.5h2" />
    </Svg>
  );
}

export function CheckIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </Svg>
  );
}

export function CheckCircleIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12.3 2.8 2.7L16 9.5" />
    </Svg>
  );
}

export function ChevronLeftIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M15 5 8 12l7 7" />
    </Svg>
  );
}

export function ChevronRightIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="m9 5 7 7-7 7" />
    </Svg>
  );
}

export function PlusIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

export function ChartIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 20h16" />
      <path d="M7 16v-4M12 16V7M17 16v-6" />
    </Svg>
  );
}

export function LogoutIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M14 4h3.5A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5H14" />
      <path d="M10 8l-4 4 4 4M6 12h9" />
    </Svg>
  );
}

export function ShieldIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 3 5 5.8v5.4c0 4.3 2.9 8.1 7 9.8 4.1-1.7 7-5.5 7-9.8V5.8z" />
      <path d="m9 12 2.2 2.2L15.5 10" />
    </Svg>
  );
}

export function AlertIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M10.3 4.2 2.9 17.5A2 2 0 0 0 4.6 20.5h14.8a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z" />
      <path d="M12 9.5v4.5M12 17.2v.1" />
    </Svg>
  );
}

export function InfoIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5M12 7.8v.1" />
    </Svg>
  );
}

export function RefreshIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M20 11a8 8 0 0 0-14.3-4.9L4 8" />
      <path d="M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16" />
      <path d="M20 20v-4h-4" />
    </Svg>
  );
}

export function CloseIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Svg>
  );
}

export function EyeIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  );
}

export function EyeOffIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M9.9 5.8A9.7 9.7 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.6 3.4M6.6 6.9C3.9 8.6 2.5 12 2.5 12S6 18.5 12 18.5c1.6 0 3-.5 4.3-1.2" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2M3.5 3.5l17 17" />
    </Svg>
  );
}

export function ClockIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5V12l3 2" />
    </Svg>
  );
}

export function WifiOffIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M2.5 8.8A15 15 0 0 1 7 6.1M10.7 5a15 15 0 0 1 10.8 3.8M5.5 12.3a10 10 0 0 1 4-2.3M14.6 10.3a10 10 0 0 1 3.9 2M8.8 15.7a5 5 0 0 1 6.4 0M12 19.5v.1M3.5 3.5l17 17" />
    </Svg>
  );
}

export function PhoneIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="6.5" y="2.5" width="11" height="19" rx="2.5" />
      <path d="M10.5 18.5h3" />
    </Svg>
  );
}

export function HandTapIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V11l.2-1.3a1.5 1.5 0 0 1 3 .3v1.5l.1-.6a1.5 1.5 0 0 1 3 .4V15a6 6 0 0 1-6 6h-.8a6 6 0 0 1-4.6-2.2l-2.6-3.2a1.6 1.6 0 0 1 2.4-2.1L9 15" />
    </Svg>
  );
}

export function CarIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M5 16.5V12l1.8-4.6A2 2 0 0 1 8.7 6h6.6a2 2 0 0 1 1.9 1.4L19 12v4.5a1 1 0 0 1-1 1h-1.5a1 1 0 0 1-1-1V16h-7v.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z" />
      <path d="M5 12h14M8 14.2h.1M16 14.2h.1" />
    </Svg>
  );
}

export function SpeakerIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" />
      <path d="M15.5 9a4.5 4.5 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11" />
    </Svg>
  );
}

/** 불러오는 중 — 가운데 도는 고리 */
export function Spinner({ className = "size-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={`animate-spin ${className}`}>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
