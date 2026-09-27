import { BrandMark } from "@/components/ui/brand";
import { Button } from "@/components/ui/button";
import { CameraIcon, HandTapIcon, ShieldIcon, SpeakerIcon, Spinner } from "@/components/ui/icons";

// 고객 시작 화면 (JOIN-02). 문자로 링크를 받은 사장님이 처음 보는 화면:
//  - 어디서 온 링크인지(봐드림 원격 A/S)와 안심 문구 — 모르는 링크는 누르지 않는다
//  - 할 일 세 단계, 그중 사람들이 가장 많이 멈추는 '허용' 창을 그림으로 미리 보여 준다
//  - 누를 것은 아래쪽 파란 버튼 하나 (엄지가 닿는 곳)
// 버튼을 누르는 동안(starting)은 권한 창이 떠 있으므로 '허용을 눌러 주세요'를 크게 보여 준다.
export function StartScreen({ starting, onStart }: { starting: boolean; onStart: () => void }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 pt-[max(16px,env(safe-area-inset-top))]">
      <header className="flex items-center gap-2 py-2">
        <BrandMark className="size-7" />
        <span className="text-label-l text-text-primary">봐드림</span>
        <span className="text-body-s text-text-secondary">원격 A/S</span>
      </header>

      <section className="flex flex-1 flex-col gap-6 pt-6 pb-4">
        {starting ? (
          <div className="flex flex-col gap-2" aria-live="polite">
            <h1 className="text-display-l text-text-primary">
              화면에 뜬 창에서
              <br />
              <span className="text-text-brand">&lsquo;허용&rsquo;</span>을 눌러 주세요
            </h1>
            <p className="text-body-l text-text-secondary">카메라와 마이크를 쓰려면 허용이 필요해요.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <h1 className="text-display-l text-text-primary">카메라를 켜 주세요</h1>
            <p className="text-body-l text-text-secondary">
              고장 난 곳을 폰 카메라로 비춰 주시면
              <br />
              기사님이 화면을 보며 도와드려요.
            </p>
          </div>
        )}

        <ol className="flex flex-col gap-3 rounded-3xl bg-bg-subtle p-4">
          <Step n={1} active={!starting}>
            아래 <b className="text-text-brand">카메라 켜기</b>를 누르세요
          </Step>
          <Step n={2} active={starting} extra={<AllowPreview />}>
            창이 뜨면 <b className="text-text-brand">허용</b>을 누르세요
          </Step>
          <Step n={3}>고장 난 곳을 비춰 주세요</Step>
        </ol>

        <ul className="flex flex-col gap-2 text-body-m text-text-secondary">
          <li className="flex items-center gap-2">
            <ShieldIcon className="size-5 flex-none text-text-success" />앱 설치·가입 없이 바로 돼요. 영상은 저장하지 않아요.
          </li>
          <li className="flex items-center gap-2">
            <SpeakerIcon className="size-5 flex-none text-icon-secondary" />기사님 목소리가 폰 스피커로 나와요.
          </li>
        </ul>
      </section>

      <div className="sticky bottom-0 -mx-5 bg-bg-page/95 px-5 pt-3 pb-[max(20px,env(safe-area-inset-bottom))] backdrop-blur">
        <Button
          size="xl"
          block
          onClick={onStart}
          disabled={starting}
          icon={starting ? <Spinner className="size-6" /> : <CameraIcon className="size-7" />}
          className="disabled:opacity-100"
        >
          {starting ? "카메라 켜는 중…" : "카메라 켜기"}
        </Button>
      </div>
    </main>
  );
}

function Step({
  n,
  active = false,
  extra,
  children,
}: {
  n: number;
  active?: boolean;
  extra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden="true"
        className={`grid size-8 flex-none place-items-center rounded-full text-label-l ${
          active ? "bg-primary text-on-primary" : "bg-bg-page text-text-secondary ring-1 ring-border"
        }`}
      >
        {n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2 pt-0.5">
        <p className="text-body-l text-text-primary">{children}</p>
        {extra}
      </div>
    </li>
  );
}

// 폰마다 권한 창 모양은 다르지만 '허용'이라는 글자는 같다 — 그 글자를 찾으라고 그림으로 보여 준다
function AllowPreview() {
  return (
    <div aria-hidden="true" className="w-full max-w-64 overflow-hidden rounded-xl bg-bg-page text-body-s shadow-card ring-1 ring-border">
      <p className="px-3 pt-2.5 pb-2 text-center text-text-secondary">카메라와 마이크에 접근하려고 합니다</p>
      <div className="grid grid-cols-2 border-t border-border text-center">
        <span className="py-2 text-text-tertiary">허용 안 함</span>
        <span className="relative border-l border-border py-2 font-bold text-text-brand">
          허용
          <HandTapIcon className="absolute top-3 right-3 size-6 text-text-primary" />
        </span>
      </div>
    </div>
  );
}
