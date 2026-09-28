import { Brand } from "@/components/ui/brand";
import { ButtonLink } from "@/components/ui/button";
import { CameraIcon, HandTapIcon, MessageIcon, ShieldIcon } from "@/components/ui/icons";

// 첫 화면 (AUTH-01, 피그마 E00). 여기 오는 사람은 둘: 로그인하려는 엔지니어와 링크 대신 주소를 친 고객(사장님).
// 파란 버튼은 엔지니어 로그인 하나. 고객에게는 할 일이 없다는 것(문자 속 링크를 누르면 된다)을 따로 알려 준다.
export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 pt-[max(16px,env(safe-area-inset-top))] pb-[max(24px,env(safe-area-inset-bottom))]">
      <header className="py-2">
        <Brand />
      </header>

      <section className="flex flex-col gap-3 pt-8 pb-8">
        <h1 className="text-display-l text-text-primary">
          설치 없이, 링크 하나로
          <br />
          봐드려요
        </h1>
        <p className="text-body-l text-text-secondary">
          사장님이 폰 카메라로 비춰 주시면, 기사님이 화면을 보고 가리키며 원격으로 A/S해 드려요.
        </p>
      </section>

      <section className="flex flex-col gap-4 rounded-3xl bg-bg-subtle p-5">
        <div className="flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-full bg-bg-page text-icon-brand">
            <MessageIcon className="size-6" />
          </span>
          <h2 className="text-title-s text-text-primary">A/S를 받으시는 사장님</h2>
        </div>
        <p className="text-body-l text-text-primary">
          기사님이 보낸 <b>문자 속 링크</b>를 눌러 주세요.
          <br />
          여기서는 따로 하실 일이 없어요.
        </p>
      </section>

      <ul className="mt-6 flex flex-col gap-4 px-1">
        <Feature icon={<CameraIcon className="size-5" />} title="앱 설치·가입 없음">
          링크를 누르고 카메라만 켜면 돼요.
        </Feature>
        <Feature icon={<HandTapIcon className="size-5" />} title="보면서 가리켜 드려요">
          누를 곳을 화면에 동그라미로 표시해 드려요.
        </Feature>
        <Feature icon={<ShieldIcon className="size-5" />} title="영상은 저장하지 않아요">
          통화가 끝나면 화면도 함께 사라져요.
        </Feature>
      </ul>

      <div className="mt-auto flex flex-col gap-2 pt-10">
        <p className="text-center text-body-s text-text-secondary">기사님(엔지니어)이신가요?</p>
        {/* 피그마 E00: 이 화면의 파란 버튼은 엔지니어 로그인 하나 */}
        <ButtonLink href="/login" size="xl" block>
          엔지니어 로그인
        </ButtonLink>
      </div>
    </main>
  );
}

function Feature({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="grid size-9 flex-none place-items-center rounded-full bg-bg-muted text-icon-secondary">
        {icon}
      </span>
      <div>
        <p className="text-label-l text-text-primary">{title}</p>
        <p className="text-body-m text-text-secondary">{children}</p>
      </div>
    </li>
  );
}
