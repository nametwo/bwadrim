// 메신저·SNS 앱 안 브라우저(인앱 브라우저) 감지 (요구사항 JOIN-10).
// 아이폰 카카오톡 안에서는 카메라가 켜지지 않고, 안드로이드도 불안정해서 기본 브라우저로 넘긴다.

// webview = 이름을 모르는 앱의 웹뷰 (detectWebView). 고객 화면에서만 쓴다
export type InAppKind =
  | "kakaotalk"
  | "line"
  | "naver"
  | "instagram"
  | "facebook"
  | "band"
  | "daum"
  | "webview";

const PATTERNS: [InAppKind, RegExp][] = [
  ["kakaotalk", /KAKAOTALK/i],
  ["line", /\bLine\//],
  ["naver", /NAVER\(inapp/i],
  ["instagram", /Instagram/i],
  ["facebook", /FBAN|FBAV|FB_IAB/],
  ["band", /\bBAND\//],
  ["daum", /DaumApps/i],
];

export function detectInApp(userAgent: string): InAppKind | null {
  return PATTERNS.find(([, re]) => re.test(userAgent))?.[0] ?? null;
}

/** 위 목록에 없는 앱의 웹뷰인지 (중고거래·카페 앱 등). 이런 화면은 카메라 권한을 앱이 따로 열어 주지 않으면 늘 거부된다.
 *  안드로이드 웹뷰는 기기 정보에 '; wv)'가 붙고, 아이폰 웹뷰(WKWebView)는 'Safari/'가 빠진다.
 *  아이폰 홈 화면 웹 앱도 'Safari/'가 없어서 웹뷰로 보이므로 고객 화면에서만 쓴다(엔지니어 화면·설치 안내에는 쓰지 않는다) */
export function detectWebView(userAgent: string): boolean {
  if (detectInApp(userAgent)) return false;
  return /; wv\)/.test(userAgent) || /(iPhone|iPad|iPod).*AppleWebKit(?!.*Safari\/)/.test(userAgent);
}

// 앱이 제공하는 '외부 브라우저로 열기' 주소. 없으면 null (사용자가 직접 열어야 한다)
export function externalOpenUrl(kind: InAppKind, url: string): string | null {
  if (kind === "kakaotalk") {
    return `kakaotalk://web/openExternal?url=${encodeURIComponent(url)}`;
  }
  if (kind === "line") {
    const u = new URL(url);
    u.searchParams.set("openExternalBrowser", "1");
    return u.toString();
  }
  return null;
}

export const IN_APP_LABEL: Record<InAppKind, string> = {
  kakaotalk: "카카오톡",
  line: "라인",
  naver: "네이버",
  instagram: "인스타그램",
  facebook: "페이스북",
  band: "밴드",
  daum: "다음",
  webview: "이 앱",
};
