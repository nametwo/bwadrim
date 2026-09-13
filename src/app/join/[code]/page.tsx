import type { Metadata } from "next";
import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { logEvent } from "@/lib/events";
import { CameraStart } from "./camera-start";

export const metadata: Metadata = {
  title: "봐드림",
};

// 고객 진입. 로그인·설치 없음 — 링크 클릭 → 버튼 한 번 → 카메라.
export default async function JoinPage({ params }: PageProps<"/join/[code]">) {
  const { code } = await params;
  const normalized = code.toUpperCase();

  let room: { id: string; status: string; expires_at: string } | null = null;
  let lookupFailed = false;

  try {
    const { data, error } = await createAdminClient()
      .from("rooms")
      .select("id, status, expires_at")
      .eq("code", normalized)
      .maybeSingle();
    if (error) throw error;
    room = data;
  } catch (e) {
    console.error("[join] 방 조회 실패:", e);
    lookupFailed = true;
  }

  if (lookupFailed) {
    return (
      <Notice title="잠시 연결이 원활하지 않아요">
        화면을 아래로 당겨 새로고침하거나, 잠시 후 다시 눌러주세요.
      </Notice>
    );
  }

  if (!room) {
    return (
      <Notice title="주소를 확인해 주세요">
        문자로 받으신 링크를 다시 한 번 눌러주세요.
      </Notice>
    );
  }

  const expired =
    room.status === "ended" || new Date(room.expires_at) < new Date();

  if (expired) {
    return (
      <Notice title="종료된 연결이에요">
        기사님께 새 링크를 보내달라고 말씀해 주세요.
      </Notice>
    );
  }

  const ua = (await headers()).get("user-agent") ?? "";
  await logEvent(room.id, "customer", "link_opened", { ua });

  return <CameraStart code={normalized} />;
}

function Notice({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-8 text-center">
      <h1 className="text-2xl font-bold">{title}</h1>
      <p className="text-lg text-gray-600">{children}</p>
    </main>
  );
}
