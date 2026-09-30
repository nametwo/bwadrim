// 카카오링크(카카오톡 친구에게 카드 보내기) — 요구사항 ROOM-13.
// SDK는 버튼을 처음 누를 때 불러온다. 고객 화면에는 쓰지 않는다.

const SDK_URL = "https://t1.kakaocdn.net/kakao_js_sdk/2.7.4/kakao.min.js";

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

function loadSdk(): Promise<KakaoSdk> {
  if (window.Kakao) return Promise.resolve(window.Kakao);
  loading ??= new Promise<KakaoSdk>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SDK_URL;
    s.async = true;
    s.onload = () => (window.Kakao ? resolve(window.Kakao) : reject(new Error("no Kakao")));
    s.onerror = () => {
      loading = null;
      reject(new Error("Kakao SDK load failed"));
    };
    document.head.appendChild(s);
  });
  return loading;
}

// 카톡 친구 선택 화면을 띄운다. SDK 로딩·초기화에 실패하면 throw.
export async function sendKakaoLink(joinUrl: string) {
  const kakao = await loadSdk();
  if (!kakao.isInitialized()) kakao.init(kakaoKey);
  const link = { mobileWebUrl: joinUrl, webUrl: joinUrl };
  kakao.Share.sendDefault({
    objectType: "feed",
    content: {
      title: "[봐드림] 폰 카메라로 비춰주세요",
      description: "아래 버튼을 눌러 주세요",
      imageUrl: `${window.location.origin}/kakao-share.png`,
      imageWidth: 800,
      imageHeight: 400,
      link,
    },
    buttons: [{ title: "카메라 켜기", link }],
  });
}
