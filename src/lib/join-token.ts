// 고객 링크(/join/{토큰})에 들어가는 추측 불가능한 값. 32자리 16진수(약 122비트).
// DB가 세션을 만들 때 채운다(supabase/schema.sql의 rooms.join_token 기본값).
// 6자리 접속 코드는 화면 표시용으로만 남는다.
const JOIN_TOKEN = /^[0-9a-f]{32}$/;

export function isJoinToken(value: unknown): value is string {
  return typeof value === "string" && JOIN_TOKEN.test(value);
}
