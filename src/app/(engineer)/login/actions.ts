"use server";

import { redirect } from "next/navigation";
import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { notifyUrgent } from "@/lib/notify";

// email: 실패해도 입력한 이메일을 다시 채워 둔다 (폼 액션이 끝나면 입력칸이 비워지므로)
export type LoginState = { error: string | null; email?: string };

// 로그인 후 이동할 곳. 같은 사이트 안의 경로만 허용한다 (BUG-08).
// 브라우저는 '\'를 '/'로 읽어 '/\evil.com'을 외부 주소로 여기므로 문자 검사만으로는 부족하다 —
// 실제로 주소를 해석해 사이트가 바뀌지 않는지 본다.
function safeNext(next: string): string {
  if (!next.startsWith("/") || next.startsWith("//") || /[\\\s]/.test(next)) {
    return "/dashboard";
  }
  const base = "https://bwadrim.invalid";
  try {
    const url = new URL(next, base);
    // '/..//evil.com'처럼 해석 뒤에 '//'로 시작하게 되는 경우도 막는다
    if (url.origin !== base || url.pathname.startsWith("//")) return "/dashboard";
    return url.pathname + url.search + url.hash;
  } catch {
    return "/dashboard";
  }
}

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

// 로그아웃 (AUTH-06). 이 기기(브라우저)만 로그아웃한다 — 사무실 PC에서 로그아웃했다고 폰의 홈 화면 앱까지
// 풀리면 다음 출장에서 다시 로그인해야 한다. 기본값(global)은 같은 계정의 모든 기기를 함께 풀어 버린다
export async function logout() {
  const supabase = await createClient();
  await supabase.auth.signOut({ scope: "local" });
  redirect("/login");
}
