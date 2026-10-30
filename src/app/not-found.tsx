import { NoticeScreen } from "@/components/ui/notice-screen";
import { ButtonLink } from "@/components/ui/button";
import { LinkIcon } from "@/components/ui/icons";
import { createClient } from "@/lib/supabase/server";

// 없는 주소·남의 세션 주소 (BUG-13, AUTH-08). 누가 보는지에 따라 다르게 보여 준다.
//  - 로그인한 엔지니어(남의 상담·틀린 주소): '상담 목록으로'
//  - 그 밖(링크가 잘못 온 사장님 등): 누를 버튼 없이 할 일만. 사이트 주소(/)는 엔지니어 로그인 화면이라(AUTH-01)
//    사장님을 그리로 보내지 않는다 — '처음으로'를 눌렀다가 로그인 화면을 만나면 더 헤맨다
// 고객 링크(/join)는 자기 화면에서 따로 안내한다. 로그인 확인에 실패하면 로그인하지 않은 것으로 본다
async function isEngineer() {
  try {
    const {
      data: { user },
    } = await (await createClient()).auth.getUser();
    return !!user;
  } catch {
    return false;
  }
}

export default async function NotFound() {
  const engineer = await isEngineer();
  return (
    <NoticeScreen
      tone="neutral"
      icon={<LinkIcon className="size-10" />}
      title="페이지를 찾을 수 없어요"
      testId="not-found"
      actions={
        engineer && (
          <ButtonLink href="/dashboard" size="xl" block data-testid="not-found-dashboard">
            상담 목록으로
          </ButtonLink>
        )
      }
    >
      {engineer ? (
        "주소가 틀렸거나 볼 수 없는 상담이에요."
      ) : (
        <>
          주소가 틀렸거나 지금은 열 수 없는 화면이에요.
          <br />
          A/S 받으시는 사장님은 문자나 카톡으로 받으신 링크를 다시 눌러 주세요.
        </>
      )}
    </NoticeScreen>
  );
}
