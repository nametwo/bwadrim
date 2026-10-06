"use client";

import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { BottomCta } from "@/components/ui/bottom-cta";
import { BrandMark } from "@/components/ui/brand";
import { Button } from "@/components/ui/button";
import {
  AddHomeIcon,
  CheckCircleIcon,
  CheckIcon,
  IosShareIcon,
  MenuIcon,
  MoreIcon,
  MoreVerticalIcon,
} from "@/components/ui/icons";
import { installPlatform, installSteps, type InstallPlatform, type InstallStep } from "@/lib/install-guide";

// 엔지니어 홈 화면 앱 설치 유도 (NFR-09). 폰 브라우저로 상담 목록을 열면 먼저 큰 설치 화면을 보여 준다.
//  - 안드로이드: 브라우저가 설치 창을 띄울 수 있으면(beforeinstallprompt) '봐드림 앱 설치' 버튼 하나. 아직이면 메뉴로 설치하는 세 단계
//  - 아이폰: 웹이 설치 창을 띄울 수 없어 세 단계를 글과 아이콘으로
//  - '다음에 할게요'·'다 했어요'면 이 브라우저 창을 닫을 때까지 다시 묻지 않는다(sessionStorage, 상담 정보 아님)
//  - 홈 화면 아이콘으로 연 앱(standalone), PC, 앱 안 브라우저, 이미 설치한 안드로이드 크롬에는 띄우지 않는다

type InstallEvent = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

// 브라우저가 설치 창을 띄울 수 있게 되면 오는 신호. 로그인 화면에서 올 수도 있어 엔지니어 화면 전체(InstallCatcher)에서 받아 둔다.
// preventDefault로 크롬의 작은 설치 띠를 막고, 우리 버튼으로 띄운다
let deferred: InstallEvent | null = null;
let installedNow = false;
let version = 0;
let started = false;
const listeners = new Set<() => void>();
const emit = () => {
  version += 1;
  for (const l of listeners) l();
};

type CaughtWindow = Window & { __bwInstall?: InstallEvent | null; __bwInstalled?: number };

function startCapture() {
  if (started) return;
  started = true;
  // 리액트가 뜨기 전에 layout의 짧은 스크립트가 잡아 둔 것
  const w = window as CaughtWindow;
  if (w.__bwInstall) deferred = w.__bwInstall;
  if (w.__bwInstalled) installedNow = true;
  if (deferred || installedNow) emit();
  // 삼성 인터넷은 서비스 워커가 있어야 앱으로 설치된다 (public/sw.js, 아무것도 가로채지 않음). 크롬·사파리는 없어도 된다
  if (/SamsungBrowser/.test(navigator.userAgent)) navigator.serviceWorker?.register("/sw.js", { scope: "/" }).catch(() => {});
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as InstallEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    installedNow = true;
    deferred = null;
    emit();
  });
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** 엔지니어 화면 어디서든 설치 신호를 받아 둔다 (engineer layout) */
export function InstallCatcher() {
  useEffect(startCapture, []);
  return null;
}

const LATER_KEY = "bwadrim:install-later";

type Guide = { platform: InstallPlatform; steps: InstallStep[] };

// 설치 화면을 띄울지는 브라우저에서만 안다 — 처음 한 번 정해 두고 그대로 쓴다(서버 그림에는 없음)
let guideCache: Guide | null | undefined;
function readGuide(): Guide | null {
  if (guideCache !== undefined) return guideCache;
  guideCache = null;
  const standalone =
    window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
  if (standalone) return guideCache;
  try {
    if (sessionStorage.getItem(LATER_KEY) === "1") return guideCache;
  } catch {
    // 저장소를 못 쓰는 창이면 매번 묻는다
  }
  const platform = installPlatform(navigator.userAgent, navigator.maxTouchPoints);
  if (platform) guideCache = { platform, steps: installSteps(navigator.userAgent, platform, navigator.maxTouchPoints) };
  return guideCache;
}

const STEP_ICON: Record<InstallStep["icon"], ReactNode> = {
  "more-vertical": <MoreVerticalIcon />,
  more: <MoreIcon />,
  share: <IosShareIcon />,
  menu: <MenuIcon />,
  "add-home": <AddHomeIcon />,
  check: <CheckIcon />,
};

// 안드로이드 크롬은 이 앱이 이미 설치됐는지 알려 준다(manifest의 related_applications). 설치했으면 브라우저로 열어도 묻지 않는다.
// 아이폰·삼성 인터넷 등은 알 수 없다 → 바로 보여 준다
type RelatedNavigator = Navigator & { getInstalledRelatedApps?: () => Promise<unknown[]> };
let installedCheck: "pending" | "installed" | "unknown" | undefined;
function checkInstalled() {
  if (installedCheck !== undefined) return;
  const nav = navigator as RelatedNavigator;
  if (!nav.getInstalledRelatedApps) {
    installedCheck = "unknown";
    return;
  }
  installedCheck = "pending";
  const done = (v: "installed" | "unknown") => {
    if (installedCheck !== "pending") return;
    installedCheck = v;
    emit();
  };
  nav
    .getInstalledRelatedApps()
    .then((apps) => done(apps.length > 0 ? "installed" : "unknown"))
    .catch(() => done("unknown"));
  // 답이 늦으면 기다리지 않고 보여 준다
  setTimeout(() => done("unknown"), 1500);
}

export function InstallPrompt() {
  const guide = useSyncExternalStore(subscribe, readGuide, () => null);
  useSyncExternalStore(subscribe, () => version, () => 0);
  const [closed, setClosed] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    startCapture();
    checkInstalled();
    emit();
  }, []);

  // 이미 설치했는지 확인이 끝나야 보여 준다 (안드로이드 크롬 1.5초 안, 그 밖은 바로)
  if (!guide || closed || installedCheck !== "unknown") return null;

  function close() {
    try {
      sessionStorage.setItem(LATER_KEY, "1");
    } catch {
      // 다음에 또 묻는다
    }
    // 상담 화면에 갔다가 돌아와도 다시 뜨지 않게
    guideCache = null;
    setClosed(true);
  }

  async function install() {
    const e = deferred;
    if (!e || asking) return;
    setAsking(true);
    try {
      await e.prompt();
      const { outcome } = await e.userChoice;
      if (outcome === "accepted") setAccepted(true);
    } catch {
      // 설치 창을 못 띄웠으면 메뉴 안내로
    } finally {
      // 설치 창은 한 번만 쓸 수 있다
      deferred = null;
      setAsking(false);
      emit();
    }
  }

  const done = accepted || installedNow;
  const oneTap = guide.platform === "android" && !!deferred && !done;
  const mode = done ? "done" : oneTap ? "button" : "steps";

  return (
    <div
      data-testid="install-prompt"
      data-platform={guide.platform}
      data-mode={mode}
      role="dialog"
      aria-modal="true"
      aria-labelledby="install-title"
      className="fixed inset-0 z-50 overflow-y-auto bg-bg-page"
    >
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 pt-[max(12px,env(safe-area-inset-top))]">
        <header className="flex h-12 items-center gap-2">
          <BrandMark className="size-7" />
          <span className="text-label-l text-text-primary">봐드림</span>
        </header>

        {done ? (
          <section className="flex flex-1 flex-col items-center justify-center gap-3 py-10 text-center">
            <div className="mb-3 grid size-24 place-items-center rounded-full bg-success-tint text-text-success">
              <CheckCircleIcon className="size-12" />
            </div>
            <h1 id="install-title" className="text-title-l">
              홈 화면에 봐드림을
              <br />
              추가했어요
            </h1>
            <p className="text-body-l text-text-secondary">다음부터 홈 화면의 봐드림 아이콘을 눌러 주세요</p>
          </section>
        ) : (
          <>
            <section className="flex flex-col gap-2 pt-4">
              <h1 id="install-title" className="text-title-l">
                봐드림을
                <br />
                홈 화면에 두세요
              </h1>
              <p className="text-body-l text-text-secondary">다음부터 아이콘만 누르면 바로 열려요</p>
            </section>

            {/* 홈 화면에 생길 모습 */}
            <div aria-hidden="true" className="mt-6 flex justify-center gap-4 rounded-3xl bg-bg-subtle px-6 py-6">
              {[0, 1, 2].map((i) => (
                <span key={i} className="flex flex-col items-center gap-1.5">
                  <span className="size-14 rounded-2xl bg-border" />
                  <span className="h-2 w-8 rounded-full bg-border" />
                </span>
              ))}
              <span className="flex flex-col items-center gap-1">
                <BrandMark className="size-14 drop-shadow-md" />
                <span className="text-label-m text-text-primary">봐드림</span>
              </span>
            </div>

            {mode === "steps" && (
              <ol className="mt-6 flex flex-col gap-4" data-testid="install-steps">
                {guide.steps.map((s, i) => (
                  <li key={i} className="flex items-start gap-3">
                    <span className="grid size-8 flex-none place-items-center rounded-full bg-primary-tint text-label-m text-text-brand">
                      {i + 1}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col pt-0.5">
                      <span className="text-body-l text-text-primary">{s.text}</span>
                      {s.sub && <span className="text-body-s text-text-secondary">{s.sub}</span>}
                    </span>
                    <span className="grid size-9 flex-none place-items-center rounded-xl bg-bg-subtle text-icon [&>svg]:size-5">
                      {STEP_ICON[s.icon]}
                    </span>
                  </li>
                ))}
              </ol>
            )}

            {guide.platform === "ios" && (
              <p className="mt-5 rounded-2xl bg-bg-subtle px-4 py-3 text-body-s text-text-secondary">
                아이폰은 홈 화면 아이콘으로 처음 열 때 한 번만 다시 로그인해요.
              </p>
            )}
          </>
        )}

        <BottomCta>
          {done ? (
            <Button variant="primary" size="xl" block onClick={close} data-testid="install-close">
              확인
            </Button>
          ) : (
            <>
              {oneTap ? (
                <Button variant="primary" size="xl" block loading={asking} onClick={install} data-testid="install-button">
                  봐드림 앱 설치
                </Button>
              ) : (
                <Button variant="secondary" size="l" block onClick={close} data-testid="install-finished">
                  다 했어요
                </Button>
              )}
              <Button variant="ghost" size="m" block onClick={close} data-testid="install-later">
                다음에 할게요
              </Button>
            </>
          )}
        </BottomCta>
      </main>
    </div>
  );
}
