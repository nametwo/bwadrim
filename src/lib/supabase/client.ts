import { createBrowserClient } from "@supabase/ssr";

// 브라우저용. 세션은 쿠키로만 관리 (localStorage 금지 원칙과도 일치)
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
