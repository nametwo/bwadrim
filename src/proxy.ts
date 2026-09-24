import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// 세션 쿠키 갱신 + 엔지니어 라우트 보호.
// 고객 진입(/join/*)은 절대 여기서 막지 않는다 — 로그인 없음이 제품 원칙.
const PROTECTED_PREFIXES = ["/dashboard", "/room", "/stats"];

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // getUser()가 만료 토큰을 갱신하고 setAll로 응답 쿠키에 반영한다
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  // 서버 액션 요청은 돌려보내지 않는다. 리다이렉트되면 액션이 알 수 없는 응답으로 실패해
  // '로그인 필요'를 알릴 수 없다. 로그인 확인은 각 액션이 한다
  const isServerAction = request.headers.has("next-action");

  if (
    !user &&
    !isServerAction &&
    PROTECTED_PREFIXES.some((p) => pathname.startsWith(p))
  ) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  if (user && !isServerAction && pathname === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  // 정적 파일·이미지 최적화는 제외. 세션 갱신을 위해 나머지 페이지는 통과시킨다.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|webp|ico)$).*)"],
};
