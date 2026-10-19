import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { safeNext } from "@/lib/safe-next";

// 카카오 동의 화면에서 돌아오는 곳 (AUTH-10). 받은 코드를 로그인 쿠키로 바꾸고 원래 가려던 화면으로 보낸다.
// 동의를 취소했거나 코드가 틀리면 로그인 화면에 '카카오 로그인을 마치지 못했어요'
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const code = searchParams.get("code");
  const next = safeNext(searchParams.get("next") ?? "");

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, request.url));
    console.error("[auth] 카카오 로그인 코드 교환 실패:", error.message);
  }

  const url = new URL("/login", request.url);
  url.searchParams.set("error", "kakao");
  if (next !== "/dashboard") url.searchParams.set("next", next);
  return NextResponse.redirect(url);
}
