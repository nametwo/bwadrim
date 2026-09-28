// 오래된 폰 브라우저에서 화면 JS가 안 돌면 '카메라 켜기'를 눌러도 아무 일도 없다 — 이것도 모르면 고칠 수 없다.
// 서버가 내려 준 HTML 안에서 바로 도는 작은 스크립트(구형 문법만)가 10초 뒤에도 JS가 붙지 않았으면
// client_error {kind: no_hydration}을 보낸다. 붙었는지는 ClientErrorReporter가 켜는 window.__bwHydrated로 본다.
// 주소의 토큰으로 /api/events에 확인받는다(고객 기록과 같은 경로).
const SCRIPT = `(function(){try{var t=(location.pathname.split('/')[2]||'');setTimeout(function(){try{if(window.__bwHydrated)return;var b=JSON.stringify({token:t,role:'customer',name:'client_error',props:{kind:'no_hydration',ms:10000,ua:String(navigator.userAgent||'').slice(0,200)}});if(navigator.sendBeacon&&window.Blob){navigator.sendBeacon('/api/events',new Blob([b],{type:'application/json'}))}else{var x=new XMLHttpRequest();x.open('POST','/api/events',true);x.setRequestHeader('Content-Type','application/json');x.send(b)}}catch(e){}},10000)}catch(e){}})();`;

export function HydrationWatchdog() {
  return <script dangerouslySetInnerHTML={{ __html: SCRIPT }} />;
}
