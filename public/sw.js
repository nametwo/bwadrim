// 봐드림 엔지니어 홈 화면 앱 (NFR-09). 삼성 인터넷은 서비스 워커가 있어야 '앱 설치'로 알아본다.
// 아무것도 저장하거나 가로채지 않는다 — 요청은 그대로 네트워크로 간다(오프라인 기능 없음)
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
