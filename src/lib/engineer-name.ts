// 엔지니어 표시 이름 (OPS-03): Supabase Auth 사용자의 user_metadata.name.
// 고객 화면의 '기다리고 있는 기사님' 카드(JOIN-02)와 대시보드 인사에 쓴다. 없으면 null — 화면은 이름 없이 보여 준다.
// 고객 정보가 아니라 엔지니어 본인 이름이다 (NFR-07과 무관).
export function engineerNameOf(user: { user_metadata?: Record<string, unknown> | null } | null | undefined) {
  const m = user?.user_metadata ?? {};
  for (const key of ["name", "full_name", "display_name"]) {
    const v = m[key];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 20);
  }
  return null;
}
