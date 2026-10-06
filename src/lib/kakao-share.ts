// 카카오톡 공유(카카오링크): 카톡 친구에게 카드 보내기, 요구사항 ROOM-14.
// SDK는 링크 보내기 화면이 뜰 때 미리 불러 둔다(loadKakao). 누르는 순간 받기 시작하면 받는 동안 '사용자가 누름' 효력이
// 끝나 안드로이드 크롬은 카톡 열기를, PC는 팝업을 막을 수 있다. 고객 화면에는 쓰지 않는다.

const SDK_URL = "https://t1.kakaocdn.net/kakao_js_sdk/2.7.4/kakao.min.js";
/** 이만큼 지나도 못 받으면 실패로 본다 — 멈춘 채 버튼이 아무 반응 없는 일이 없게 */
const LOAD_TIMEOUT_MS = 8000;

type KakaoSdk = {
  isInitialized(): boolean;
  init(key: string): void;
  Share: { sendDefault(settings: object): void };
};

declare global {
  interface Window {
    Kakao?: KakaoSdk;
  }
}

export const kakaoKey = process.env.NEXT_PUBLIC_KAKAO_JS_KEY ?? "";

let loading: Promise<KakaoSdk> | null = null;

/** SDK를 불러 둔다. 실패하면(못 받음·시간 초과·받았는데 SDK가 아님) 다음에 부를 때 처음부터 다시 받는다 */
export function loadKakao(): Promise<KakaoSdk> {
  if (window.Kakao) return Promise.resolve(window.Kakao);
  loading ??= new Promise<KakaoSdk>((resolve, reject) => {
    const s = document.createElement("script");
    // 한 번만 끝낸다 — 시간 초과 뒤에 늦게 온 onload가 다음 시도의 loading을 지우지 않게
    let settled = false;
    const fail = (why: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      loading = null;
      s.remove();
      reject(new Error(why));
    };
    const timer = setTimeout(() => fail("Kakao SDK load timeout"), LOAD_TIMEOUT_MS);
    s.src = SDK_URL;
    s.async = true;
    s.onload = () => {
      if (!window.Kakao) return fail("no Kakao");
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(window.Kakao);
    };
    s.onerror = () => fail("Kakao SDK load failed");
    document.head.appendChild(s);
  });
  return loading;
}

// 카톡 친구 선택 화면을 띄운다. SDK 로딩·초기화에 실패하면 throw.
// 미리 불러 뒀으면 기다리지 않고 바로 연다(누른 그 순간 안에서)
// roomId는 전송 성공 웹훅(api/kakao/share-webhook, ROOM-15)이 어느 상담인지 알게 실어 보낸다.
// 이 값이 없으면 카카오가 웹훅을 보내지 않는다
export async function sendKakaoLink(joinUrl: string, roomId: string) {
  const kakao = window.Kakao ?? (await loadKakao());
  if (!kakao.isInitialized()) kakao.init(kakaoKey);
  const link = { mobileWebUrl: joinUrl, webUrl: joinUrl };
  kakao.Share.sendDefault({
    objectType: "feed",
    content: {
      title: "[봐드림] 폰 카메라로 비춰 주세요",
      description: "아래 버튼을 눌러 주세요",
      imageUrl: `${window.location.origin}/kakao-share.png`,
      imageWidth: 800,
      imageHeight: 400,
      link,
    },
    buttons: [{ title: "카메라 켜기", link }],
    serverCallbackArgs: { room: roomId },
  });
}
