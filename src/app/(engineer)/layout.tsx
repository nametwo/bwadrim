import type { Metadata } from "next";
import { headers } from "next/headers";
import { detectInApp, IN_APP_LABEL } from "@/lib/in-app-browser";
import { OpenInBrowser } from "@/components/open-in-browser";
import { manifestHref } from "@/lib/browser-kind";

// 엔지니어 화면에만 웹 앱 설정을 붙인다. 플레이 스토어 앱(TWA, OPS-08)이 이름·아이콘·색을 여기서 가져간다.
// 고객 링크(/join)에는 걸지 않아 고객 폰에 '앱 설치'가 뜨지 않는다.
// 홈 화면에 추가하라고 권하지 않는다(2026-10-19 NFR-09 폐기). 크롬이 스스로 띄우는 작은 '앱 설치' 띠도 막는다.
// 예전에 삼성 인터넷에만 등록하던 서비스 워커(/sw.js)는 열 때 지운다 (BUG-24). 리액트보다 먼저 돌아야 해서 HTML에 바로 둔다
const PAGE_SETUP = `(function(w){w.addEventListener('beforeinstallprompt',function(e){e.preventDefault();});var sw=navigator.serviceWorker;sw&&sw.getRegistrations().then(function(rs){rs.forEach(function(r){var u=(r.active||r.waiting||r.installing||{}).scriptURL||'';if(u.slice(-6)==='/sw.js')r.unregister();});}).catch(function(){});})(window);`;

// 앱(TWA)·크롬의 위쪽 상태 띠를 화면 바탕색에 맞춘다 (NFR-12). 대시보드는 회색, 상담 화면은 흰색, 통화는 검정이라
// 띠가 늘 흰색이면 화면과 따로 놀아 웹을 감싼 티가 난다. 화면 맨 위 왼쪽 가장자리(카드는 좌우 여백이 있어 바탕이 보이는 자리)에
// 겹친 것 중 맨 위의 불투명한 바탕색을 읽어(반투명한 확인 창 뒤 가림막은 건너뜀) theme-color로 넣는다. 화면이 바뀌면(DOM 변화) 0.15초 안에 다시 읽는다. 캔버스로 색을 #hex로 바꾼다
const STATUS_BAR_COLOR = `(function(d,w){var m,c,t,last;function pick(){t=0;var els=d.elementsFromPoint(2,1),i,x,p,h;c=c||d.createElement('canvas').getContext('2d',{willReadFrequently:true});for(i=0;i<els.length;i++){x=getComputedStyle(els[i]).backgroundColor;c.clearRect(0,0,1,1);c.fillStyle='#0000';c.fillStyle=x;c.fillRect(0,0,1,1);p=c.getImageData(0,0,1,1).data;if(p[3]===255){h='#'+((1<<24)|(p[0]<<16)|(p[1]<<8)|p[2]).toString(16).slice(1);if(h!==last){last=h;if(!m){m=d.querySelector('meta[name="theme-color"]');if(!m){m=d.createElement('meta');m.name='theme-color';d.head.appendChild(m);}}m.content=h;}return;}}}function soon(){if(!t)t=setTimeout(pick,150);}new MutationObserver(soon).observe(d.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['class','style','data-state']});w.addEventListener('load',soon);w.addEventListener('resize',soon);soon();})(document,window);`;

// 웹 앱 설정(manifest)은 브라우저마다 다르게 아래에서 붙인다 — 삼성 인터넷은 앱으로 설치되지 않는 설정 (BUG-24)
export const metadata: Metadata = {
  appleWebApp: { capable: true, title: "봐드림", statusBarStyle: "default" },
};

// 엔지니어 화면(로그인·대시보드·상담·통계)도 메신저 앱 안 브라우저면 인터넷 앱으로 넘긴다 (AUTH-09).
// 앱 안에서는 마이크가 잘 안 켜지고(CALL-01), 로그인도 인터넷 앱과 따로라 거기서 다시 해야 한다
export default async function EngineerLayout({ children }: LayoutProps<"/">) {
  const ua = (await headers()).get("user-agent") ?? "";
  const inApp = detectInApp(ua);
  // 리액트가 <head>로 옮긴다. Next 메타데이터로 요청마다 다르게 주면 본문 끝에 늦게 붙을 수 있어 직접 쓴다
  // (미리보기 배포는 로그인 쿠키가 있어야 파일을 받는다 — Next가 manifest에 하던 그대로)
  const manifest = (
    <link
      rel="manifest"
      href={manifestHref(ua)}
      crossOrigin={process.env.VERCEL_ENV === "preview" ? "use-credentials" : undefined}
    />
  );
  if (!inApp) {
    return (
      <>
        {manifest}
        <script dangerouslySetInnerHTML={{ __html: PAGE_SETUP }} />
        <script dangerouslySetInnerHTML={{ __html: STATUS_BAR_COLOR }} />
        {children}
      </>
    );
  }

  return (
    <>
      {manifest}
      <OpenInBrowser
        kind={inApp}
        testId="eng-in-app"
        title={
          <>
            크롬이나 사파리에서
            <br />
            열어 주세요
          </>
        }
        body={
          <>
            {IN_APP_LABEL[inApp]} 안에서는
            <br />
            마이크가 잘 안 켜져요.
          </>
        }
      >
        {children}
      </OpenInBrowser>
    </>
  );
}
