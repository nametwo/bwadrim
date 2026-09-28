import { NoticeScreen } from "@/components/ui/notice-screen";
import { ButtonLink } from "@/components/ui/button";
import { LinkIcon } from "@/components/ui/icons";

// 없는 주소·남의 세션 주소 (BUG-13). 고객 링크(/join)는 자기 화면에서 따로 안내한다
export default function NotFound() {
  return (
    <NoticeScreen
      tone="neutral"
      icon={<LinkIcon className="size-10" />}
      title="페이지를 찾을 수 없어요"
      actions={
        <ButtonLink href="/" variant="secondary" size="l" block>
          처음으로
        </ButtonLink>
      }
    >
      주소가 틀렸거나 볼 수 없는 상담이에요.
      <br />
      A/S 받으시는 사장님은 문자 속 링크를 다시 눌러 주세요.
    </NoticeScreen>
  );
}
