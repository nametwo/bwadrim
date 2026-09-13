export default function Home() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-6 p-8 text-center">
      <h1 className="text-4xl font-bold">봐드림</h1>
      <p className="text-lg text-gray-600 max-w-md">
        설치 없이, 링크 하나로. 폰 카메라로 비춰주시면 엔지니어가 원격으로
        봐드립니다.
      </p>
      <div className="flex gap-3">
        <a
          href="/login"
          className="rounded-lg bg-black px-6 py-3 text-white text-lg"
        >
          엔지니어 로그인
        </a>
      </div>
      <p className="text-sm text-gray-400">
        고객님은 문자로 받으신 링크를 눌러주세요.
      </p>
    </main>
  );
}
