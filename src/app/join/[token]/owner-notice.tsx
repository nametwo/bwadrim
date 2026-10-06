import { NoticeScreen } from "@/components/ui/notice-screen";
import { ButtonLink } from "@/components/ui/button";
import { LinkIcon } from "@/components/ui/icons";

// 엔지니어가 로그인한 채로 자기 상담 링크를 열었을 때 (JOIN-13). 고객에게 보낸 카톡·문자에서 눌러 본 경우 등.
// 고객 화면을 바로 열면 '카메라 켜고 시작하기' 한 번에 진짜 고객 자리를 이어받으므로(CALL-13) 상담 화면으로 보낸다.
// 자기 폰으로 고객 화면을 시험해 볼 수 있게 '고객 화면 열어 보기'는 남긴다
export function OwnerNotice({ roomId, token }: { roomId: string; token: string }) {
  return (
    <NoticeScreen
      testId="join-owner"
      icon={<LinkIcon className="size-10" />}
      title="고객님께 보낸 링크예요"
      actions={
        <>
          <ButtonLink href={`/room/${roomId}`} size="xl" block data-testid="join-owner-room">
            상담 화면으로
          </ButtonLink>
          <ButtonLink
            href={`/join/${token}?as=customer`}
            variant="ghost"
            size="m"
            block
            data-testid="join-owner-preview"
          >
            고객 화면 열어 보기
          </ButtonLink>
        </>
      }
      footer="고객 화면에서 카메라를 켜면 고객님 대신 이 기기가 연결돼요."
    >
      엔지니어 계정으로 로그인돼 있어서
      <br />
      고객 화면은 열지 않았어요.
    </NoticeScreen>
  );
}
