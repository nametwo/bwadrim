import Link from "next/link";
import { BUSINESS, isBlank } from "@/lib/business-info";

// 로그인 화면 맨 아래 운영 사업자 정보와 개인정보 처리방침 링크 (AUTH-02, NFR-10).
// 사이트 주소가 곧 로그인 화면이라(AUTH-01) 누가 운영하는지는 여기서 보인다. 정하지 않은 값은 뺀다
export function BusinessFooter() {
  const first = [
    BUSINESS.name,
    isBlank(BUSINESS.owner) ? null : `대표 ${BUSINESS.owner}`,
    isBlank(BUSINESS.regNo) ? null : `사업자등록번호 ${BUSINESS.regNo}`,
  ].filter(Boolean);

  return (
    <footer data-testid="business-footer" className="flex flex-col items-center gap-1 pt-6 pb-[max(16px,env(safe-area-inset-bottom))] text-center text-body-s text-text-tertiary">
      <Link href="/privacy" className="mb-1 font-bold text-text-secondary underline underline-offset-2">
        개인정보 처리방침
      </Link>
      <p>{first.join(" · ")}</p>
      <p>{BUSINESS.address}</p>
      <p>{BUSINESS.email}</p>
    </footer>
  );
}
