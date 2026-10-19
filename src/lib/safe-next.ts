// 로그인 후 이동할 곳. 같은 사이트 안의 경로만 허용한다 (BUG-08).
// 브라우저는 '\'를 '/'로 읽어 '/\evil.com'을 외부 주소로 여기므로 문자 검사만으로는 부족하다 —
// 실제로 주소를 해석해 사이트가 바뀌지 않는지 본다. 이메일 로그인과 카카오 로그인 돌아오기(AUTH-10)가 같이 쓴다
export function safeNext(next: string): string {
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
