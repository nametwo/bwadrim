"use server";

import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// 카카오로 가입한 계정이면 카카오 쪽 연결도 끊는다(동의 내역이 남지 않게). 어드민 키가 없거나 실패해도 탈퇴는 계속한다
async function unlinkKakao(user: User) {
  const key = process.env.KAKAO_ADMIN_KEY;
  const kakao = user.identities?.find((i) => i.provider === "kakao");
  const kakaoId = kakao?.identity_data?.provider_id ?? kakao?.identity_data?.sub ?? kakao?.id;
  if (!key || !kakaoId) return;
  try {
    const res = await fetch("https://kapi.kakao.com/v1/user/unlink", {
      method: "POST",
      headers: { Authorization: `KakaoAK ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ target_id_type: "user_id", target_id: String(kakaoId) }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) console.error("[account] 카카오 연결 끊기 실패:", res.status);
  } catch (e) {
    console.error("[account] 카카오 연결 끊기 실패:", e);
  }
}

// 회원 탈퇴 (AUTH-11). 계정을 지우면 상담·지표 기록·받는 분 이름표·한도도 DB에서 같이 지워진다(on delete cascade).
// 되돌릴 수 없다. 화면은 확인 창을 한 번 거친다
export async function deleteAccount() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  await unlinkKakao(user);
  const { error } = await createAdminClient().auth.admin.deleteUser(user.id);
  if (error) throw new Error(`탈퇴 실패: ${error.message}`);

  // 지운 계정의 로그인 쿠키를 비운다. 서버의 세션은 이미 없어서 실패해도 괜찮다
  await supabase.auth.signOut().catch(() => {});
  redirect("/login?deleted=1");
}
