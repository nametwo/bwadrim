import type { BrowserContext, Page } from "@playwright/test";

// 화면 카탈로그용 브라우저 조작 손잡이. 앱 코드는 건드리지 않고, 페이지가 뜨기 전에(addInitScript) 브라우저 API를 감싼다.
//  - 카메라·마이크 요청(getUserMedia): 원하는 오류로 실패(거부·다른 앱 사용 중·카메라 없음, 마이크만도) /
//    붙잡아 두기('켜는 중…' 화면) / 카메라 전환만 거부(needs_tap)·실패
//  - 손전등: 가짜 카메라에 torch 기능이 있는 척 (CALL-11)
//  - 연결 상태: 열린 RTCPeerConnection을 'disconnected'(잠깐 끊김)·'failed'(실패)로 바꾼 척 (CALL-07, JOIN-09)
//  - 공유 기능(navigator.share): 폰처럼 있는 척 (ROOM-07 버튼)
//  - 홈 화면 앱 설치 신호(beforeinstallprompt): 안드로이드 크롬처럼 보낸 척 (NFR-09). 설치 창은 띄우지 않고 고른 답을 돌려준다

export interface HookOptions {
  /** navigator.share가 있는 척 (폰 브라우저) */
  share?: boolean;
  /** 가짜 카메라에 손전등이 있는 척 */
  torch?: boolean;
}

/** 카메라·마이크 요청 실패: name = DOMException 이름, audio = 마이크를 달라는 요청만 실패 */
export interface GumFail {
  name: "NotAllowedError" | "NotReadableError" | "NotFoundError";
  audio?: boolean;
}

interface CatHooks {
  hold: boolean;
  fail: GumFail | null;
  /** 카메라 전환(영상만 요청) 거부: 탭이 있어야 바꿀 수 있는 폰 흉내 */
  flipNeedsTap: boolean;
  /** 앞으로 이 횟수만큼 카메라 전환 요청을 실패시킨다 */
  flipFails: number;
  torch: boolean;
  release(): void;
  peerState(state: RTCPeerConnectionState): number;
}

declare global {
  interface Window {
    __cat: CatHooks;
  }
}

function install(opts: HookOptions) {
  let release: () => void = () => {};
  let held: Promise<void> | null = null;
  const peers = new Set<RTCPeerConnection>();

  const cat: CatHooks = {
    hold: false,
    fail: null,
    flipNeedsTap: false,
    flipFails: 0,
    torch: !!opts.torch,
    release: () => release(),
    peerState: (state) => {
      let n = 0;
      for (const pc of peers) {
        if (pc.signalingState === "closed") continue;
        Object.defineProperty(pc, "connectionState", { get: () => state, configurable: true });
        pc.onconnectionstatechange?.(new Event("connectionstatechange"));
        n++;
      }
      return n;
    },
  };
  window.__cat = cat;

  const md = navigator.mediaDevices;
  const gum = md.getUserMedia.bind(md);
  md.getUserMedia = async (c?: MediaStreamConstraints) => {
    const videoOnly = !!c?.video && !c?.audio;
    if (cat.fail && (!cat.fail.audio || c?.audio)) throw new DOMException("catalog", cat.fail.name);
    if (cat.hold) {
      held ??= new Promise<void>((r) => (release = r));
      await held;
      held = null;
    }
    if (videoOnly && cat.flipNeedsTap) throw new DOMException("catalog: needs tap", "NotAllowedError");
    if (videoOnly && cat.flipFails > 0) {
      cat.flipFails--;
      throw new DOMException("catalog: flip failed", "NotReadableError");
    }
    return gum(c);
  };

  const caps = MediaStreamTrack.prototype.getCapabilities;
  MediaStreamTrack.prototype.getCapabilities = function (this: MediaStreamTrack) {
    const base = caps ? caps.call(this) : ({} as MediaTrackCapabilities);
    return this.kind === "video" && cat.torch ? ({ ...base, torch: true } as MediaTrackCapabilities) : base;
  };
  const apply = MediaStreamTrack.prototype.applyConstraints;
  MediaStreamTrack.prototype.applyConstraints = function (this: MediaStreamTrack, c?: MediaTrackConstraints) {
    if (cat.torch && c?.advanced?.some((s) => "torch" in s)) return Promise.resolve();
    return apply.call(this, c);
  };

  const PC = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends PC {
    constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
      super(...args);
      peers.add(this);
    }
  };

  if (opts.share && !navigator.share) {
    Object.defineProperty(navigator, "share", { value: async () => {}, configurable: true });
  }
}

export async function installHooks(context: BrowserContext, opts: HookOptions = {}) {
  await context.addInitScript(install, opts);
}

/** 안드로이드 크롬이 '설치할 수 있어요'(beforeinstallprompt)를 보낸 척 (NFR-09). outcome = 설치 창에서 고를 답 */
export function fireInstallPrompt(page: Page, outcome: "accepted" | "dismissed" = "accepted") {
  return page.evaluate((o) => {
    const e = new Event("beforeinstallprompt", { cancelable: true }) as Event & {
      prompt(): Promise<void>;
      userChoice: Promise<{ outcome: string; platform: string }>;
    };
    e.prompt = async () => {
      (window as unknown as { __installPrompted?: number }).__installPrompted =
        ((window as unknown as { __installPrompted?: number }).__installPrompted ?? 0) + 1;
    };
    e.userChoice = Promise.resolve({ outcome: o, platform: "web" });
    window.dispatchEvent(e);
  }, outcome);
}

/** 이 창에서는 홈 화면 앱 설치 안내를 이미 넘긴 척 — 다른 대시보드 장면을 가리지 않게 (NFR-09) */
export async function skipInstallPrompt(context: BrowserContext) {
  await context.addInitScript(() => {
    try {
      sessionStorage.setItem("bwadrim:install-later", "1");
    } catch {}
  });
}

/** 카메라·마이크 요청을 이 오류로 실패시킨다 (null이면 되돌림) */
export function failGum(page: Page, fail: GumFail | null) {
  return page.evaluate((f) => (window.__cat.fail = f), fail);
}

/** 카메라·마이크 요청을 붙잡아 둔다 — 권한 창이 떠 있는 동안의 화면 */
export function holdGum(page: Page) {
  return page.evaluate(() => (window.__cat.hold = true));
}

export function releaseGum(page: Page) {
  return page.evaluate(() => {
    window.__cat.hold = false;
    window.__cat.release();
  });
}

/** 카메라 기능이 없는 화면(오래된 브라우저·앱 안 화면)인 척 */
export function removeCamera(page: Page) {
  return page.evaluate(() => Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true }));
}

export function setFlip(page: Page, f: { needsTap?: boolean; fails?: number }) {
  return page.evaluate((f) => {
    window.__cat.flipNeedsTap = !!f.needsTap;
    window.__cat.flipFails = f.fails ?? 0;
  }, f);
}

/** 연결 상태를 바꾼 척: 'disconnected' = 잠깐 끊김, 'failed' = 실패, 'connected' = 다시 붙음 */
export function setPeerState(page: Page, state: RTCPeerConnectionState) {
  return page.evaluate((s) => window.__cat.peerState(s), state);
}
