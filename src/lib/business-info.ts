// 운영 사업자 정보 — 로그인 화면 아래(AUTH-02)와 개인정보 처리방침(NFR-10)에 쓴다.
// 플레이 스토어에 공개되는 개발자 정보(상호·주소)와 같게 둔다(OPS-08).
// 빈 글자('')는 아직 정하지 않은 값이다. 로그인 화면은 빈 값을 빼고, 처리방침은 '정하는 중'으로 보여 준다.
// 플레이 심사에 내기 전에 모두 채울 것

export const BUSINESS = {
  /** 상호 (사업자등록증) */
  name: "에코정보통신",
  /** 대표자 이름 */
  owner: "",
  /** 사업자등록번호 (000-00-00000) */
  regNo: "",
  /** 사업장 주소 */
  address: "대전광역시 중구 대종로 611, 301호 (선화동, 임하빌딩)",
  /** 문의·개인정보 요청 메일 (Cloudflare 메일 전달, OPS-07) */
  email: "contact@bwadrim.com",
  /** 개인정보 보호책임자 */
  privacyOfficer: { name: "", phone: "" },
  /** 처리방침 시행일 (2026-10-20 형식) */
  privacyEffectiveDate: "",
} as const;

/** 아직 안 정한 값인지 */
export function isBlank(value: string): boolean {
  return value.trim() === "";
}
