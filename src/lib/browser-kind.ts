// 브라우저·기기 가리기. 고객 카메라 안내(JOIN-05)와 엔지니어 화면의 웹 앱 설정(OPS-08, BUG-24)이 쓴다

/** 삼성 인터넷인지 (BUG-24). 삼성 인터넷은 홈 화면 앱을 자기가 만든 APK로 설치하는데, 2026년 들어 Play 프로텍트가
 *  이 APK를 'Android 이전 버전에 맞게 개발된 앱'이라며 '안전하지 않은 앱 차단됨'으로 막는다. 우리 쪽 설정으로는 그 APK를 고칠 수 없다 */
export function isSamsungInternet(ua: string): boolean {
  return /SamsungBrowser\//.test(ua);
}

/** 엔지니어 화면에 붙일 웹 앱 설정. 삼성 인터넷에는 앱으로 설치되지 않는 설정(display: browser)을 준다 (BUG-24).
 *  설정을 아예 빼면 안 된다: 크로미움은 설정이 없어도 /dashboard 같은 최상위 주소를 앱으로 설치해 준다(설정이 browser면 안 함) */
export function manifestHref(ua: string): string {
  return isSamsungInternet(ua) ? "/manifest-samsung.webmanifest" : "/manifest.webmanifest";
}

/** 아이폰·아이패드인지. iPadOS 13+ 사파리는 맥처럼 보인다 — 맥인데 터치가 되면 아이패드 */
export function isIOSDevice(ua: string, maxTouchPoints = 0): boolean {
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1);
}

// 아이폰의 사파리가 아닌 인터넷 앱과, 폰 설정 앱에 보이는 그 앱 이름
const IOS_BROWSER_APPS: [RegExp, string][] = [
  [/CriOS/i, "Chrome"],
  [/FxiOS/i, "Firefox"],
  [/EdgiOS/i, "Edge"],
  [/OPiOS/i, "Opera"],
  [/Whale/i, "Whale"],
  [/NAVER/i, "NAVER"],
];

/** 아이폰에서 연 인터넷 앱 이름. 사파리면 null.
 *  사파리가 아닌 앱은 카메라 권한이 '설정 → 그 앱'에 있다(JOIN-05) */
export function iosBrowserApp(ua: string): string | null {
  return IOS_BROWSER_APPS.find(([re]) => re.test(ua))?.[1] ?? null;
}
