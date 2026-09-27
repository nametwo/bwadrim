import type { Metadata } from "next";
import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { logEvent } from "@/lib/events";
import { detectInApp } from "@/lib/in-app-browser";
import { isJoinToken } from "@/lib/join-token";
import { NoticeScreen } from "@/components/ui/notice-screen";
import { buttonClass } from "@/components/ui/button";
import { ClockIcon, LinkIcon, RefreshIcon, WifiOffIcon } from "@/components/ui/icons";
import { CameraStart } from "./camera-start";
import { OpenInBrowser } from "./open-in-browser";

// 문자·카톡 미리보기에 뜨는 제목과 설명 — 모르는 링크로 보이지 않게 무엇인지 밝힌다. 검색에는 안 나오게
export const metadata: Metadata = {
  title: "봐드림 원격 A/S",
  description: "링크를 누르고 카메라를 켜면 기사님이 화면을 보며 도와드려요. 앱 설치 없이 바로 돼요.",
  robots: { index: false, follow: false },
  openGraph: {
    title: "봐드림 원격 A/S",
    description: "링크를 누르고 카메라를 켜면 기사님이 화면을 보며 도와드려요. 앱 설치 없이 바로 돼요.",
  },
};

// 고객 진입. 로그인·설치 없음 — 링크 클릭 → 버튼 한 번 → 카메라.
export default async function JoinPage({ params }: PageProps<"/join/[token]">) {
  const { token } = await params;

  let room: { id: string; status: string; expires_at: string } | null = null;
  let lookupFailed = false;

  // 형식이 틀리면(예전 6자리 링크 포함) DB에 묻지 않고 '주소를 확인해 주세요'
  if (isJoinToken(token)) {
    try {
      const { data, error } = await createAdminClient()
        .from("rooms")
        .select("id, status, expires_at")
        .eq("join_token", token)
        .maybeSingle();
      if (error) throw error;
      room = data;
    } catch (e) {
      console.error("[join] 방 조회 실패:", e);
      lookupFailed = true;
    }
  }

  if (lookupFailed) {
    return (
      <NoticeScreen
        tone="warning"
        icon={<WifiOffIcon className="size-10" />}
        title="잠시 연결이 원활하지 않아요"
        actions={
          // 같은 주소를 다시 연다 (새로고침)
          <a href={`/join/${token}`} className={buttonClass({ size: "xl", block: true })}>
            <RefreshIcon className="size-6" />
            다시 열기
          </a>
        }
      >
        잠시 후 아래 버튼을 눌러 주세요.
      </NoticeScreen>
    );
  }

  if (!room) {
    return (
      <NoticeScreen tone="neutral" icon={<LinkIcon className="size-10" />} title="주소를 확인해 주세요">
        문자로 받으신 링크를 다시 한 번 눌러 주세요.
        <br />
        그래도 안 되면 기사님께 새 링크를 보내 달라고 말씀해 주세요.
      </NoticeScreen>
    );
  }

  const expired =
    room.status === "ended" || new Date(room.expires_at) < new Date();

  if (expired) {
    return (
      <NoticeScreen tone="neutral" icon={<ClockIcon className="size-10" />} title="이미 끝난 상담 링크예요">
        다시 도움이 필요하면
        <br />
        기사님께 새 링크를 보내 달라고 말씀해 주세요.
      </NoticeScreen>
    );
  }

  const ua = (await headers()).get("user-agent") ?? "";
  const inApp = detectInApp(ua);
  await logEvent(room.id, "customer", "link_opened", { ua, inapp: inApp });

  if (inApp) {
    return <OpenInBrowser kind={inApp} roomId={room.id} token={token} />;
  }
  return <CameraStart roomId={room.id} token={token} />;
}
