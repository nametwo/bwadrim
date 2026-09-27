"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import type { DataLink } from "@/lib/webrtc/data-link";
import {
  CustomerAnchorSession,
  EMPTY_CUSTOMER_SNAPSHOT,
  type CustomerSnapshot,
} from "@/lib/tracking/session";
import { AnchorOverlay } from "@/components/anchor-overlay";
import { SessionHolder } from "./session-holder";
import { customerUntrackable } from "./usage";
import { AnnotatedPhoto } from "./annotated-photo";

// 고객 통화 화면의 AR 핀 층 (CALL-14). 고객은 아무것도 누르지 않는다 — 모두 자동, 터치를 받지 않는다.
//  - 찾으면: 영상 위 빨간 핀 (물체에 붙어 움직임)
//  - 핀이 화면 밖: 가장자리 빨간 화살표 + 큰 글씨 '화살표 쪽으로 폰을 돌려주세요'
//  - 못 찾음(0.8초 이상, 또는 이 기준으로는 못 찾음): 기사님이 표시한 사진 카드 + '기사님이 표시한 곳을 비춰주세요'
// 영상은 잘림 없이 전체(object-contain, JOIN-06)라 fit도 contain.

/** 화살표를 둘 안쪽 여백: 위 상태 문구·아래 버튼을 피한다 (CSS px) */
const GUIDE_INSET = { top: 140, bottom: 150, left: 24, right: 24 };
/**
 * 추적기가 이 앵커로 아직 한 프레임도 못 봤으면(첫 갱신 전) 카드를 미룬다 — 기준 사진 전송·Worker 시작에
 * 1초 가까이 걸릴 수 있다. 끝내 응답이 없으면(Worker 실패 등) 이 시간이 지나 카드를 보인다.
 */
const CARD_FIRST_LOOK_MAX_MS = 2500;

function select(s: CustomerSnapshot) {
  const st = s.update?.state;
  return {
    anchor: s.anchor,
    cardUrl: s.cardUrl,
    showCard: s.showCard,
    arrow: s.arrow,
    looked: s.update !== null,
    shown: !!s.update?.H && (st === "tracking" || st === "weak"),
    untrackable: customerUntrackable(s.update),
  };
}

/** 지금 고객 화면에 AR 안내(카드·화살표)가 떠 있는지 — 상태 문구를 숨길 때 쓴다 */
export type CustomerAnchorBanner = "card" | "arrow" | "pin" | null;

export function CustomerAnchorLayer({
  video,
  link,
  hidden,
  onBanner,
}: {
  video: RefObject<HTMLVideoElement | null>;
  link: DataLink;
  /** CALL-09 정지 화면 중: 핀 층을 숨긴다 (추적은 계속) */
  hidden: boolean;
  onBanner?(banner: CustomerAnchorBanner): void;
}) {
  const [holder] = useState(
    () => new SessionHolder<CustomerAnchorSession, CustomerSnapshot>(EMPTY_CUSTOMER_SNAPSHOT),
  );
  const [view] = useState(() => holder.selector(select));
  const [getUpdate] = useState(() => () => holder.current()?.latestUpdate() ?? null);
  const snap = useSyncExternalStore(view.subscribe, view.getSnapshot, view.getServerSnapshot);
  const [cardForcedFor, setCardForcedFor] = useState<string | null>(null);
  const onBannerRef = useRef(onBanner);

  useEffect(() => {
    onBannerRef.current = onBanner;
  });

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    const s = new CustomerAnchorSession({ video: v, link, fit: "contain" });
    holder.set(s);
    return () => {
      holder.set(null);
      s.destroy();
    };
  }, [holder, link, video]);

  const waitingFirstLook = snap.anchor && !snap.looked ? snap.anchor.id : null;
  useEffect(() => {
    if (!waitingFirstLook) return;
    const t = setTimeout(() => setCardForcedFor(waitingFirstLook), CARD_FIRST_LOOK_MAX_MS);
    return () => clearTimeout(t);
  }, [waitingFirstLook]);

  const cardAllowed = snap.looked || (!!snap.anchor && cardForcedFor === snap.anchor.id);
  const wantCard = (snap.showCard && cardAllowed) || snap.untrackable;
  const card =
    !hidden && wantCard && !snap.arrow && snap.anchor && snap.cardUrl
      ? { anchor: snap.anchor, url: snap.cardUrl }
      : null;
  const arrow = !hidden && !card && snap.arrow;
  const pin = !hidden && !card && !arrow && !!snap.anchor && snap.shown;
  const banner: CustomerAnchorBanner = card ? "card" : arrow ? "arrow" : pin ? "pin" : null;

  useEffect(() => {
    onBannerRef.current?.(banner);
  }, [banner]);

  if (hidden) return null;

  return (
    <>
      <AnchorOverlay
        video={video}
        fit="contain"
        anchor={snap.anchor}
        update={null}
        getUpdate={getUpdate}
        guideInset={GUIDE_INSET}
        className="anchor-overlay"
      />
      {(card || arrow) && (
        <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-col items-center px-3 pt-[max(12px,env(safe-area-inset-top))]">
          {card ? (
            <div
              data-testid="cust-card"
              role="alert"
              className="flex h-[50svh] min-h-[300px] w-full max-w-md flex-col gap-3 rounded-3xl bg-bg-page p-4 text-text-primary shadow-2xl"
            >
              <p className="text-center text-[26px] leading-tight font-extrabold tracking-tight break-keep">
                기사님이 표시한 곳을
                <br />
                비춰주세요
              </p>
              <AnnotatedPhoto
                src={card.url}
                anchor={card.anchor}
                alt="기사님이 표시한 사진"
                className="min-h-0 w-full flex-1"
              />
            </div>
          ) : (
            <p
              data-testid="cust-arrow-text"
              role="alert"
              className="w-full max-w-md rounded-3xl bg-black-80 px-5 py-5 text-center text-[28px] leading-tight font-extrabold text-call-text break-keep shadow-2xl"
            >
              화살표 쪽으로
              <br />
              폰을 돌려주세요
            </p>
          )}
        </div>
      )}
    </>
  );
}
