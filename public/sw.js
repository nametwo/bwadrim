// 2026-10-07까지 삼성 인터넷에만 등록하던 서비스 워커 (NFR-09). 삼성 인터넷이 이것을 보고 홈 화면 앱을 자기 APK로 만들었고,
// Play 프로텍트가 그 APK를 막았다 (BUG-24). 이제 등록하지 않는다. 이미 등록된 폰은 다음에 열 때 이 파일로 바뀌어 스스로 지운다.
// 주소(/sw.js)는 남겨 둔다 — 파일이 없으면 브라우저가 바꿔 받지 못해 예전 것이 그대로 남는다
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.registration.unregister()));
