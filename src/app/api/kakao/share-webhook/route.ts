import { after, NextResponse } from "next/server";
import { logEvent } from "@/lib/events";
import { isFromKakao, parseShareWebhook } from "@/lib/kakao-webhook";

// 카카오톡 공유 웹훅 받기 (ROOM-15). 카카오 개발자 콘솔 > 앱 > 웹훅 > 카카오톡 공유 웹훅에
// 이 주소(https://서비스 주소/api/kakao/share-webhook)를 등록한다. 서버 전용 KAKAO_ADMIN_KEY 필요.
// 카카오는 3초 안에 2XX를 받아야 하고, 오류가 잦으면 웹훅을 꺼 버린다 → 기록은 응답 뒤로 미루고,
// 카카오가 보낸 요청이면 형식이 틀려도 2XX를 준다(다시 받아도 결과가 같다).

async function handle(request: Request, params: Record<string, unknown>) {
  const adminKey = process.env.KAKAO_ADMIN_KEY;
  if (!adminKey) console.error("[kakao-webhook] KAKAO_ADMIN_KEY 미설정");
  if (!isFromKakao(request.headers.get("authorization"), adminKey)) {
    if (adminKey) console.warn("[kakao-webhook] 어드민 키 불일치");
    return new NextResponse(null, { status: 401 });
  }

  const hook = parseShareWebhook(params);
  if (!hook) {
    console.warn("[kakao-webhook] 형식이 다른 요청:", Object.keys(params).join(","));
    return new NextResponse(null, { status: 200 });
  }

  const resourceId = request.headers.get("x-kakao-resource-id");
  after(() =>
    logEvent(hook.roomId, "system", "kakao_sent", {
      chat_type: hook.chatType,
      hash_chat_id: hook.hashChatId,
      resource_id: resourceId,
    }),
  );
  return new NextResponse(null, { status: 200 });
}

export async function POST(request: Request) {
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    // 본문이 JSON이 아니면 아래에서 형식 오류로 처리
  }
  const params = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  return handle(request, params);
}

// 콘솔에서 GET 방식으로 등록한 경우: 값이 쿼리로 온다
export async function GET(request: Request) {
  return handle(request, Object.fromEntries(new URL(request.url).searchParams));
}
