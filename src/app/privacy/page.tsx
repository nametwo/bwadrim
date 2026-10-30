import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Brand } from "@/components/ui/brand";
import { BUSINESS, isBlank } from "@/lib/business-info";

// 개인정보 처리방침 (NFR-10). 로그인 없이 열린다 — 플레이 스토어 심사와 고객이 볼 수 있어야 해서.
// 적은 내용은 코드가 실제로 모으는 것과 같아야 한다: 엔지니어 계정(카카오 가입 AUTH-10, 탈퇴 AUTH-11)·상담 기록·한 달 한도(ROOM-17), 받는 분 이름표·카톡 방 해시(ROOM-16·OPS-06),
// 고객 이벤트(link_opened의 브라우저 정보, 카메라·연결, DATA-01·04). 고객 이름·전화번호는 받지 않는다(NFR-07).
// 모으는 것을 바꾸면 여기도 같이 고칠 것
export const metadata: Metadata = {
  title: "개인정보 처리방침 | 봐드림",
};

/** 아직 정하지 않은 값 — 플레이 심사 전에 src/lib/business-info.ts를 채운다 */
function Value({ v }: { v: string }) {
  if (isBlank(v)) return <span className="text-text-tertiary">정하는 중</span>;
  return <>{v}</>;
}

function Section({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-title-s text-text-primary">
        {n}. {title}
      </h2>
      <div className="flex flex-col gap-3 text-body-m text-text-secondary">{children}</div>
    </section>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-3xl bg-bg-subtle px-5 py-4">
      <p className="text-label-l text-text-primary">{title}</p>
      {children}
    </div>
  );
}

export default function PrivacyPage() {
  const officer = BUSINESS.privacyOfficer;
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col px-5 pt-[max(12px,env(safe-area-inset-top))] pb-12">
      {/* 로고는 누르는 곳이 아니다 — 사이트 주소(/)는 엔지니어 로그인 화면이라(AUTH-01) 고객 화면에서 온 사장님을 그리로 보내지 않는다.
          돌아갈 곳은 브라우저 뒤로가기(로그인 화면·고객 시작 화면)다 */}
      <header className="flex h-12 items-center">
        <Brand />
      </header>

      <h1 className="pt-8 text-title-l text-text-primary">개인정보 처리방침</h1>
      <p className="pt-2 pb-8 text-body-m text-text-secondary">
        봐드림은 {BUSINESS.name}이 운영하는 원격 A/S 서비스예요. 어떤 개인정보를 왜 받고, 언제 지우는지 적어 두었어요.
      </p>

      <div className="flex flex-col gap-10">
        <Section n={1} title="받는 개인정보와 쓰는 곳">
          <Card title="엔지니어 (봐드림으로 A/S 하는 기사님)">
            <p>카카오로 가입하시면 카카오에서 회원번호, 닉네임, 프로필 사진 주소를 받아요. 이메일은 카카오 동의 화면에서 동의하신 경우에만 받아요. 로그인하고, 고객 화면에 기사님 이름을 보여 주는 데 써요.</p>
            <p>관리자가 만든 이메일 계정은 이메일, 비밀번호, 이름을 저장해요. 비밀번호는 암호화해서 저장해요.</p>
            <p>상담을 만든 시각, 끝난 시각, 연결됐는지, 통화 중에 가리키기나 화면 멈춤 같은 도구를 썼는지를 남겨요. 상담 목록과 통계, 한 달에 만들 수 있는 상담 수를 세는 데 써요.</p>
          </Card>
          <Card title="받는 분 이름표">
            <p>엔지니어가 링크를 보낸 뒤 직접 적은 받는 분 이름(30자까지)과, 카카오톡으로 보냈을 때 카카오가 알려 주는 채팅방 구분 값(해시)을 저장해요. 지난 상담을 누구와 했는지 알아보는 데 써요.</p>
          </Card>
          <Card title="고객 (링크로 A/S 받는 사장님)">
            <p>이름과 전화번호는 받지 않아요. 링크를 보낼 사람은 엔지니어 폰의 문자 앱이나 카카오톡에서 골라요.</p>
            <p>링크를 열면 브라우저와 기기 종류(User-Agent), 카메라를 허용했는지, 영상이 어떤 길로 연결됐는지를 남겨요. 연결이 안 되는 원인을 찾고 품질을 높이는 데 써요.</p>
          </Card>
          <Card title="영상, 음성, 사진">
            <p>영상과 음성은 고객 폰과 엔지니어 기기가 직접 주고받고, 서버에 저장하지 않아요. 직접 연결이 안 될 때만 중계 서버를 거치는데, 암호화된 채로 지나가서 중계 서버도 내용을 볼 수 없어요.</p>
            <p>통화 중에 찍은 사진은 서버에 올리지 않아요. 엔지니어가 저장할 때만 엔지니어 기기에 남아요.</p>
          </Card>
          <Card title="자동으로 남는 것">
            <p>엔지니어 로그인을 유지하려고 쿠키를 써요. 서비스를 맡긴 업체(아래 4번)의 서버 기록에 접속한 IP 주소와 시각이 남을 수 있어요.</p>
          </Card>
        </Section>

        <Section n={2} title="보관 기간과 지우는 방법">
          <p>엔지니어 계정과 상담 기록은 탈퇴할 때까지 보관해요. 탈퇴하시면 바로 계정과 그 계정의 상담 기록, 이름표를 함께 지워요. 카카오로 가입한 계정은 카카오 연결도 끊어요.</p>
          <p>받는 분 이름표는 그분께 마지막으로 링크를 보낸 날부터 1년이 지나면 자동으로 지워요. 1년이 지난 상담에 남은 카카오톡 채팅방 구분 값도 함께 지워요.</p>
          <p>카메라를 허용했는지와 영상이 어떤 길로 연결됐는지는 그 상담 기록과 함께 두고, 상담 기록을 지울 때 같이 지워요. 브라우저와 기기 종류는 그보다 먼저, 링크를 연 날부터 1년이 지나면 지워요.</p>
          <p>지울 때는 데이터베이스에서 되살릴 수 없게 지워요.</p>
        </Section>

        <Section n={3} title="다른 곳에 주는 경우">
          <p>받은 개인정보를 다른 회사나 사람에게 주지 않아요. 법에 따라 수사기관 등이 정해진 절차로 요구할 때만 예외예요.</p>
        </Section>

        <Section n={4} title="맡긴 업체">
          <p>서비스를 돌리려고 아래 업체에 일을 맡겨요. 맡긴 일 말고는 쓰지 않도록 각 업체의 약관과 보호 조치를 따라요.</p>
          <ul className="flex flex-col gap-2">
            <li>
              <b className="text-text-primary">Supabase</b>: 데이터베이스와 로그인. 서울 리전에 저장해요.
            </li>
            <li>
              <b className="text-text-primary">Vercel</b>: 웹 서버. 서울 리전에서 실행해요.
            </li>
            <li>
              <b className="text-text-primary">Cloudflare</b>: 영상 중계 서버, 도메인, 문의 메일 전달.
            </li>
            <li>
              <b className="text-text-primary">카카오</b>: 엔지니어 카카오 로그인, 카카오톡으로 링크를 보낼 때 전송과 전송 결과(채팅방 종류와 구분 값) 알림.
            </li>
            <li>
              <b className="text-text-primary">Discord</b>: 운영자에게 상담 진행과 장애 알림. 기사님 이름, 받는 분 이름표, 고객 기기 종류, 연결 결과가 가요.
            </li>
          </ul>
          <p>Supabase, Vercel, Cloudflare, Discord는 미국 회사예요. 저장은 서울에서 하지만, 업체가 관리를 위해 해외에서 접근할 수 있고 영상 중계는 가까운 해외 서버를 거칠 수 있어요.</p>
        </Section>

        <Section n={5} title="요청하실 수 있는 것">
          <p>
            내 개인정보를 보거나, 고치거나, 지우거나, 쓰지 말라고 요청하실 수 있어요. {BUSINESS.email}로 메일을 보내 주시면 본인인지 확인하고 처리해요.
          </p>
          <div id="delete-account" className="scroll-mt-4">
            <Card title="엔지니어 계정 지우기 (탈퇴)">
              <p>앱이나 웹에서 로그인한 뒤 상담 목록 위쪽 &lsquo;내 계정&rsquo;을 누르고 &lsquo;회원 탈퇴&rsquo;를 누르세요. 확인하면 바로 지워져요.</p>
              <p>로그인할 수 없으면 {BUSINESS.email}로 가입한 방법(카카오나 이메일)과 함께 메일을 보내 주세요. 본인인지 확인하고 지워 드려요.</p>
            </Card>
          </div>
        </Section>

        <Section n={6} title="안전하게 지키는 방법">
          <p>모든 통신은 암호화(HTTPS)해요. 비밀번호는 암호화해서 저장해요.</p>
          <p>엔지니어는 자기 상담만 볼 수 있어요. 고객 링크는 추측할 수 없는 주소이고 24시간이 지나면 열리지 않아요.</p>
        </Section>

        <Section n={7} title="개인정보 보호책임자">
          <Card title={BUSINESS.name}>
            <p>
              책임자: <Value v={officer.name} />
            </p>
            <p>
              전화: <Value v={officer.phone} />
            </p>
            <p>메일: {BUSINESS.email}</p>
          </Card>
        </Section>

        <Section n={8} title="도움받을 수 있는 곳">
          <p>개인정보 침해로 도움이 필요하시면 아래 기관에 문의하실 수 있어요.</p>
          <ul className="flex flex-col gap-1">
            <li>개인정보침해신고센터: privacy.kisa.or.kr, 국번 없이 118</li>
            <li>개인정보분쟁조정위원회: www.kopico.go.kr, 1833-6972</li>
            <li>대검찰청: www.spo.go.kr, 국번 없이 1301</li>
            <li>경찰청: ecrm.police.go.kr, 국번 없이 182</li>
          </ul>
        </Section>

        <Section n={9} title="운영자">
          <p>
            {BUSINESS.name}, 대표 <Value v={BUSINESS.owner} />, 사업자등록번호 <Value v={BUSINESS.regNo} />
          </p>
          <p>{BUSINESS.address}</p>
          <p>
            시행일: <Value v={BUSINESS.privacyEffectiveDate} />
          </p>
        </Section>
      </div>
    </main>
  );
}
