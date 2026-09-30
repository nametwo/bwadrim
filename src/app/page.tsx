import { redirect } from "next/navigation";

// 첫 화면 (AUTH-01): 따로 보여 줄 화면이 없다. 고객은 문자 속 링크(/join)로 바로 들어오니
// 사이트 주소로 오는 사람은 엔지니어다. 로그인으로 보내고, 로그인했으면 대시보드 — 보통은 proxy가 먼저 보낸다
export default function Home() {
  redirect("/login");
}
