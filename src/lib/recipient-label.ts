// 받는 분 이름표 글자 (ROOM-16). 엔지니어 화면(입력칸)과 서버(저장)가 같이 쓴다.
// 이름은 엔지니어 마음대로 붙인다(사람 이름·상호 등). DB 제약도 1~30자다(supabase/schema.sql)

export const LABEL_MAX = 30;

/** 앞뒤·겹친 공백을 줄이고 30자까지 자른다. 비면 null */
export function cleanLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/\s+/g, " ").trim();
  return s ? Array.from(s).slice(0, LABEL_MAX).join("") : null;
}
