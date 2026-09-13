import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// service role 클라이언트. RLS를 우회하므로 서버 코드에서만 import할 것.
// 고객(anon)은 방·이벤트에 직접 접근하지 않고 항상 이 경로를 거친다.
export function createAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
