import { Brand } from "@/components/ui/brand";
import { BottomCta } from "@/components/ui/bottom-cta";
import { ButtonLink } from "@/components/ui/button";
import { CameraIcon, HandTapIcon, MessageIcon, ShieldIcon } from "@/components/ui/icons";

// 첫 화면 (AUTH-01, 피그마 E00). 여기 오는 사람은 둘: 로그인하려는 엔지니어와 링크 대신 주소를 친 고객(사장님).
// 사장님이 로그인 버튼을 누르지 않게 파란(지금 누를 것) 버튼은 두지 않는다 — 사장님 안내 카드가 가장 눈에 띄고,
// 엔지니어 로그인은 맨 아래 회색 버튼.
export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 pt-[max(12px,env(safe-area-inset-top))]">
      <header className="flex h-12 items-center">
        <Brand />
      </header>

      <section className="flex flex-col gap-3 pt-8 pb-8">
        <h1 className="text-display-l text-text-primary">
          고장 난 곳,
          <br />
          기사님이 봐드려요
        </h1>
        <p className="text-body-l text-text-secondary">
          문자 속 링크를 누르고
          <br />
          폰 카메라로 비추면 돼요
        </p>
      </section>

      {/* 주소를 직접 친 사장님께: 여기서는 할 일이 없다 */}
      <section className="flex items-start gap-4 rounded-3xl bg-primary-tint p-5">
        <span className="grid size-12 flex-none place-items-center rounded-full bg-bg-page text-icon-brand">
          <MessageIcon className="size-6" />
        </span>
        <div className="flex flex-col gap-1">
          <h2 className="text-title-s text-text-primary">A/S 받으시는 사장님께</h2>
          <p className="text-body-l text-text-primary">
            기사님이 보낸 <b>문자 속 링크</b>를 눌러 주세요. 이 화면에서는 하실 게 없어요.
          </p>
        </div>
      </section>

      <ul className="mt-8 flex flex-col gap-5 px-1">
        <Feature icon={<CameraIcon className="size-5" />} title="앱은 안 깔아도 돼요">
          링크 열고 카메라만 켜면 끝이에요
        </Feature>
        <Feature icon={<HandTapIcon className="size-5" />} title="누를 곳을 짚어 드려요">
          화면에 빨간 동그라미가 떠요
        </Feature>
        <Feature icon={<ShieldIcon className="size-5" />} title="통화 영상은 남기지 않아요">
          사진을 찍으면 그때마다 알림이 떠요
        </Feature>
      </ul>

      <BottomCta>
        <ButtonLink href="/login" variant="secondary" size="l" block>
          엔지니어 로그인
        </ButtonLink>
      </BottomCta>
    </main>
  );
}

function Feature({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-4">
      <span className="grid size-11 flex-none place-items-center rounded-full bg-bg-muted text-icon-secondary">
        {icon}
      </span>
      <div className="flex flex-col">
        <p className="text-label-l text-text-primary">{title}</p>
        <p className="text-body-s text-text-secondary">{children}</p>
      </div>
    </li>
  );
}
