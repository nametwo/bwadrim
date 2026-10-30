"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { safeNext } from "@/lib/safe-next";
import { notifyUrgent } from "@/lib/notify";

// email: 실패해도 입력한 이메일을 다시 채워 둔다 (폼 액션이 끝나면 입력칸이 비워지므로)
export type LoginState = { error: string | null; email?: string };

export async function login(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { error: "이메일과 비밀번호를 입력해 주세요.", email };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    // 서버와 연결이 안 된 것(Supabase 장애·네트워크)은 비밀번호 탓이 아니다 — 관리자가 준 비밀번호를
    // 의심하지 않게 따로 안내한다 (AUTH-03). supabase-js는 이 경우도 throw하지 않고 error로 돌려준다
    if (isAuthRetryableFetchError(error)) {
      notifyUrgent(
        "auth-down",
        `🚨 Supabase 인증에 닿지 않아요 — 기사님이 로그인을 못 해요 (${error.message}). Supabase 프로젝트가 멈추지 않았는지와 status.supabase.com을 봐 주세요`,
      );
      return { error: "지금 서버와 연결이 안 돼요. 조금 있다가 \u2018로그인\u2019을 다시 눌러 주세요.", email };
    }
    return { error: "이메일이나 비밀번호가 맞지 않아요.", email };
  }

  redirect(safeNext(String(formData.get("next") ?? "")));
}

// 카카오로 시작하기 (AUTH-10). 처음이면 그대로 가입된다.
// 카카오 동의 화면을 거쳐 /auth/callback으로 돌아온다. 돌아올 주소는 엔지니어가 지금 연 주소로 만든다(OPS-07)
export async function loginWithKakao(formData: FormData) {
  const h = await headers();
  const host = h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? "http";
  const next = safeNext(String(formData.get("next") ?? ""));
  const callback = `${proto}://${host}/auth/callback?next=${encodeURIComponent(next)}`;

  const supabase = await createClient();
  // 동의 항목은 닉네임만. 비워 두면 Supabase가 이메일·프로필 사진까지 달라고 해서, 카카오 콘솔에
  // 그 항목을 켜 두지 않으면 KOE205(설정하지 않은 동의 항목)로 막힌다 (OPS-10)
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "kakao",
    options: { redirectTo: callback, scopes: "profile_nickname" },
  });
  if (error || !data.url) redirect("/login?error=kakao");
  redirect(data.url);
}

// 로그아웃 (AUTH-06). 이 기기(브라우저)만 로그아웃한다 — 사무실 PC에서 로그아웃했다고 폰의 홈 화면 앱까지
// 풀리면 다음 출장에서 다시 로그인해야 한다. 기본값(global)은 같은 계정의 모든 기기를 함께 풀어 버린다
export async function logout() {
  const supabase = await createClient();
  await supabase.auth.signOut({ scope: "local" });
  redirect("/login");
}
