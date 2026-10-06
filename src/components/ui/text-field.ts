// 글 입력칸 (피그마 TextField). 면으로 구분한다: 흰 화면엔 회색 면, 회색 카드 안에선 흰 면.
// 누르면 흰 바탕 + 파란 테두리, 틀리면(aria-invalid) 빨간 테두리. 글자는 body-l(18px) — 폰이 확대하지 않는 크기
export function textFieldClass({ onCard = false }: { onCard?: boolean } = {}) {
  return `h-14 w-full rounded-2xl border-2 border-transparent px-4 text-body-l text-text-primary outline-none transition-colors placeholder:text-text-tertiary focus:border-border-focus focus:bg-bg-page aria-invalid:border-danger ${
    onCard ? "bg-bg-page" : "bg-bg-subtle"
  }`;
}
