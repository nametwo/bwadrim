// 앱(TWA)의 오프라인 화면 서비스 워커 (NFR-12). 등록은 src/app/(engineer)/layout.tsx의 OFFLINE_SETUP:
// 플레이 앱을 크롬이 띄울 때만 등록한다. 삼성 인터넷에는 등록하지 않는다 — 삼성 인터넷은 서비스 워커가 있으면
// 홈 화면 앱을 자기 APK로 만들고 Play 프로텍트가 그것을 막는다(BUG-24). 예전 /sw.js와는 다른 파일이다(그건 스스로 지운다).
// 하는 일은 하나: 화면을 여는 요청(navigate)이 네트워크 오류로 실패하면 미리 받아 둔 /offline.html을 내준다.
// 그 밖의 요청(데이터·이미지·통화 신호)은 건드리지 않고, 아무것도 캐시하지 않는다. 오프라인 화면을 바꾸면 CACHE 이름을 올린다
const CACHE = "bwadrim-offline-v1";
const PAGE = "/offline.html";

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.add(new Request(PAGE, { cache: "reload" })))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
      // 서비스 워커가 깨는 동안 화면 요청이 기다리지 않게 네트워크 요청을 미리 출발시킨다
      if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.mode !== "navigate") return;
  e.respondWith(
    (async () => {
      try {
        return (await e.preloadResponse) || (await fetch(e.request));
      } catch {
        return (await caches.match(PAGE)) || Response.error();
      }
    })(),
  );
});
