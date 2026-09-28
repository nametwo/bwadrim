import type { Metadata } from "next";
import { headers } from "next/headers";
import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logEvent } from "@/lib/events";
import { notify } from "@/lib/alerts";
import { errorText } from "@/lib/alert-rules";
import { detectInApp } from "@/lib/in-app-browser";
import { isJoinToken } from "@/lib/join-token";
import { engineerNameOf } from "@/lib/engineer-name";
import { NoticeScreen } from "@/components/ui/notice-screen";
import { buttonClass } from "@/components/ui/button";
import { ClockIcon, LinkIcon, RefreshIcon, WifiOffIcon } from "@/components/ui/icons";
import { CameraStart } from "./camera-start";
import { OpenInBrowser } from "./open-in-browser";
import { HydrationWatchdog } from "./hydration-watchdog";

// 방 조회가 이보다 늦으면 기다리지 않고 '잠깐 연결이 안 돼요'를 보여 준다 (JOIN-03)
const LOOKUP_TIMEOUT_MS = 4000;

// 끝났거나 만료된 링크를 열었다 (DATA-01 link_blocked). 새로고침을 반복해도 상담마다 10분에 한 번만 남긴다
async function logLinkBlocked(roomId: string, reason: "ended" | "expired", inapp: string | null) {
  const since = new Date(Date.now() - 10 * 60_000).toISOString();
  const { data } = await createAdminClient()
    .from("events")
    .select("id")
    .eq("room_id", roomId)
    .eq("name", "link_blocked")
    .gte("created_at", since)
    .limit(1);
  if (data?.length) return;
  await logEvent(roomId, "customer", "link_blocked", { reason, inapp });
}

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

// 고객 진입. 로그인·설치 없음 — 링크 클릭 → 버튼 한 번 → 카메라.
export default async function JoinPage({ params }: PageProps<"/join/[token]">) {
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
        .abortSignal(AbortSignal.timeout(LOOKUP_TIMEOUT_MS))
        .maybeSingle();
      if (error) throw error;
      room = data;
    } catch (e) {
      console.error("[join] 방 조회 실패:", e);
      lookupFailed = true;
      // 어느 상담인지 몰라 events에는 못 남긴다 — 고객이 링크를 못 여는 중이므로 응급 알림
      after(() =>
        notify("alert", {
          title: "고객 링크를 열 수 없어요 (방 조회 실패)",
          lines: [errorText(e), `${LOOKUP_TIMEOUT_MS / 1000}초 제한. Supabase 상태를 확인해 주세요.`],
          key: "db-lookup",
          cooldownSec: 900,
        }),
      );
    }
  } else {
    // 잘린 링크·예전 6자리 링크·봇. 어느 상담인지 몰라 서버 로그에만 (events에 넣으면 봇 요청이 쌓인다)
    console.info("[join] 형식이 틀린 링크");
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
    console.info("[join] 없는 링크");
    return (
      <NoticeScreen tone="neutral" icon={<LinkIcon className="size-10" />} title="열 수 없는 링크예요">
        문자 속 링크를 다시 한 번 눌러 주세요.
        <br />
        그래도 안 열리면 기사님께 새 링크를 받아 주세요.
      </NoticeScreen>
    );
  }

  const ua = (await headers()).get("user-agent") ?? "";
  const inApp = detectInApp(ua);
  const roomId = room.id;

  // 피그마 C06: 누를 버튼 없이 할 일(새 링크 요청)만 안내
  if (room.status === "ended") {
    after(() => logLinkBlocked(roomId, "ended", inApp));
    return (
      <NoticeScreen tone="neutral" icon={<ClockIcon className="size-10" />} title="상담이 이미 끝났어요">
        도움이 더 필요하시면
        <br />
        기사님께 새 링크를 받아 주세요.
      </NoticeScreen>
    );
  }
  if (new Date(room.expires_at) < new Date()) {
    after(() => logLinkBlocked(roomId, "expired", inApp));
    return (
      <NoticeScreen tone="neutral" icon={<ClockIcon className="size-10" />} title="링크가 만료됐어요">
        링크는 24시간만 쓸 수 있어요.
        <br />
        기사님께 새 링크를 받아 주세요.
      </NoticeScreen>
    );
  }

  // 기록은 화면을 보낸 뒤에 — DB가 느려도 고객 첫 화면이 늦어지지 않게
  after(() => logEvent(roomId, "customer", "link_opened", { ua, inapp: inApp }));

  // 누가 기다리는지 (JOIN-02 기사님 카드). 엔지니어 계정에 표시 이름이 없거나 조회에 실패하면 이름 없이
  const engineerName = await createAdminClient()
    .auth.admin.getUserById(room.engineer_id)
    .then(({ data }) => engineerNameOf(data.user))
    .catch(() => null);

  return (
    <>
      <HydrationWatchdog />
      {inApp ? (
        <OpenInBrowser kind={inApp} roomId={room.id} token={token} engineerName={engineerName} />
      ) : (
        <CameraStart roomId={room.id} token={token} engineerName={engineerName} />
      )}
    </>
  );
}
