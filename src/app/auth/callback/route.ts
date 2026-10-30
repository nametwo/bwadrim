import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { notifyUrgent } from "@/lib/notify";
import { safeNext } from "@/lib/safe-next";

// 카카오 동의 화면에서 돌아오는 곳 (AUTH-10). 받은 코드를 로그인 쿠키로 바꾸고 원래 가려던 화면으로 보낸다.
// 동의를 취소했거나 코드가 틀리면 로그인 화면에 '카카오 로그인을 마치지 못했어요'.
// 막힌 이유(Supabase가 붙여 보낸 error·error_description, 코드 교환 오류)는 화면에 보이지 않으니 서버 로그와
// 디스코드 응급 채널(OPS-09)에 남긴다 — 설정 문제(동의 항목·시크릿·가입 허용)를 콘솔을 뒤지지 않고 알게
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const code = searchParams.get("code");
  const next = safeNext(searchParams.get("next") ?? "");

  let reason: string;
  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, request.url));
    reason = `코드 교환 실패: ${error.message}`;
  } else {
    // Supabase가 카카오와 주고받다 막히면 코드 대신 error·error_code·error_description을 붙여 보낸다
    const parts = ["error", "error_code", "error_description"]
      .map((k) => searchParams.get(k))
      .filter((v): v is string => !!v);
    reason = parts.length ? `Supabase 오류: ${parts.join(" / ")}` : "코드도 오류도 없이 돌아옴";
  }
  console.error("[auth] 카카오 로그인 실패:", reason);
  notifyUrgent(`kakao-login:${reason.slice(0, 60)}`, `🚨 카카오 로그인 실패 — ${reason}`);

  const url = new URL("/login", request.url);
  url.searchParams.set("error", "kakao");
  if (next !== "/dashboard") url.searchParams.set("next", next);
  return NextResponse.redirect(url);
}
