"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { safeNext } from "@/lib/safe-next";

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
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "kakao",
    options: { redirectTo: callback },
  });
  if (error || !data.url) redirect("/login?error=kakao");
  redirect(data.url);
}

export async function logout() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
