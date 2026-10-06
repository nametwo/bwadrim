import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { logEvent } from "@/lib/events";
import { detectInApp, IN_APP_LABEL } from "@/lib/in-app-browser";
import { isPreviewBot } from "@/lib/preview-bot";
import { isJoinToken } from "@/lib/join-token";
import { engineerNameOf } from "@/lib/engineer-name";
import { NoticeScreen } from "@/components/ui/notice-screen";
import { OpenInBrowser } from "@/components/open-in-browser";
import { buttonClass } from "@/components/ui/button";
import { ClockIcon, LinkIcon, RefreshIcon, WifiOffIcon } from "@/components/ui/icons";
import { CameraStart } from "./camera-start";
import { OwnerNotice } from "./owner-notice";

// 문자·카톡 미리보기에 뜨는 제목과 설명 — 모르는 링크로 보이지 않게 무엇인지 밝힌다. 검색에는 안 나오게
export const metadata: Metadata = {
  title: "봐드림 원격 A/S",
  description: "카메라로 비춰 주시면 기사님이 보면서 알려 드려요. 앱은 안 깔아도 돼요.",
  robots: { index: false, follow: false },
  openGraph: {
    title: "봐드림 원격 A/S",
    description: "카메라로 비춰 주시면 기사님이 보면서 알려 드려요. 앱은 안 깔아도 돼요.",
  },
};

// 이 상담을 만든 엔지니어가 로그인한 채로 열었는지 (JOIN-13). 고객 폰에는 로그인 쿠키가 없어 서버에 묻지 않고 바로 false다.
// 확인에 실패하면 고객으로 본다 — 엔지니어 안내 때문에 고객 화면이 막히면 안 된다
async function openedByOwner(engineerId: string) {
  try {
    const {
      data: { user },
    } = await (await createClient()).auth.getUser();
    return user?.id === engineerId;
  } catch {
    return false;
  }
}

// 고객 진입. 로그인·설치 없음 — 링크 클릭 → 버튼 한 번 → 카메라.
export default async function JoinPage({ params, searchParams }: PageProps<"/join/[token]">) {
  const { token } = await params;

  let room: { id: string; status: string; expires_at: string; engineer_id: string } | null = null;
  let lookupFailed = false;

  // 형식이 틀리면(예전 6자리 링크 포함) DB에 묻지 않고 '주소를 확인해 주세요'
  if (isJoinToken(token)) {
    try {
      const { data, error } = await createAdminClient()
        .from("rooms")
        .select("id, status, expires_at, engineer_id")
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
        title="잠깐 연결이 안 돼요"
        actions={
          // 같은 주소를 다시 연다 (새로고침)
          <a href={`/join/${token}`} className={buttonClass({ size: "xl", block: true })}>
            <RefreshIcon className="size-6" />
            다시 열기
          </a>
        }
      >
        조금 있다가 아래 버튼을 눌러 주세요.
      </NoticeScreen>
    );
  }

  if (!room) {
    return (
      <NoticeScreen tone="neutral" icon={<LinkIcon className="size-10" />} title="열 수 없는 링크예요">
        문자 속 링크를 다시 한 번 눌러 주세요.
        <br />
        그래도 안 열리면 기사님께 새 링크를 받아 주세요.
      </NoticeScreen>
    );
  }

  // 엔지니어가 자기 링크를 열면 고객으로 기록하지 않고 고객 자리(통화 채널)에도 들이지 않는다 (JOIN-13).
  // 끝났거나 만료된 상담은 그 상담 화면(ROOM-11)으로, 진행 중이면 '고객님께 보낸 링크예요'.
  // 거기서 '고객 화면 열어 보기'(?as=customer)를 누르면 고객 화면을 보여 주되 link_opened는 남기지 않는다
  const owner = await openedByOwner(room.engineer_id);
  if (owner && (room.status === "ended" || new Date(room.expires_at) < new Date())) {
    redirect(`/room/${room.id}`);
  }
  if (owner && (await searchParams).as !== "customer") {
    return <OwnerNotice roomId={room.id} token={token} />;
  }

  // 피그마 C06: 누를 버튼 없이 할 일(새 링크 요청)만 안내
  if (room.status === "ended") {
    return (
      <NoticeScreen tone="neutral" icon={<ClockIcon className="size-10" />} title="상담이 이미 끝났어요">
        도움이 더 필요하시면
        <br />
        기사님께 새 링크를 받아 주세요.
      </NoticeScreen>
    );
  }
  if (new Date(room.expires_at) < new Date()) {
    return (
      <NoticeScreen tone="neutral" icon={<ClockIcon className="size-10" />} title="링크가 만료됐어요">
        링크는 24시간만 쓸 수 있어요.
        <br />
        기사님께 새 링크를 받아 주세요.
      </NoticeScreen>
    );
  }

  const ua = (await headers()).get("user-agent") ?? "";
  const inApp = detectInApp(ua);
  // 문자·카톡이 미리보기를 만들려고 가져간 요청과 엔지니어 본인의 열어 보기는 고객이 연 것이 아니다 (DATA-01).
  // 화면과 미리보기 정보(metadata)는 똑같이 내보낸다
  if (!owner && !isPreviewBot(ua)) {
    await logEvent(room.id, "customer", "link_opened", { ua, inapp: inApp });
  }

  // 누가 기다리는지 (JOIN-02 기사님 카드). 엔지니어 계정에 표시 이름이 없거나 조회에 실패하면 이름 없이
  const engineerName = await createAdminClient()
    .auth.admin.getUserById(room.engineer_id)
    .then(({ data }) => engineerNameOf(data.user))
    .catch(() => null);

  const start = <CameraStart roomId={room.id} token={token} engineerName={engineerName} />;
  if (inApp) {
    return (
      <OpenInBrowser
        kind={inApp}
        testId="join-in-app"
        title={
          <>
            이 화면에서는
            <br />
            카메라가 안 켜져요
          </>
        }
        body={
          <>
            {IN_APP_LABEL[inApp]} 안에서 열려서 그래요.
            <br />
            사파리나 크롬으로 열면 돼요.
          </>
        }
      >
        {start}
      </OpenInBrowser>
    );
  }
  return start;
}
