import Link from "next/link";

// 없는 주소·남의 세션 주소 (BUG-13). 고객 링크(/join)는 자기 화면에서 따로 안내한다
export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-8 text-center">
      <h1 className="text-2xl font-bold">페이지를 찾을 수 없어요</h1>
      <p className="text-lg text-gray-600">
        주소가 잘못됐거나 볼 수 없는 세션이에요.
        <br />
        고객님은 문자로 받으신 링크를 다시 눌러주세요.
      </p>
      <Link
        href="/"
        className="mt-2 rounded-xl border border-gray-300 px-6 py-3 text-gray-700"
      >
        처음으로
      </Link>
    </main>
  );
}
