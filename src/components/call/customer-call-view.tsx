"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { DataLink } from "@/lib/webrtc/data-link";
import {
  CustomerAnchorSession,
  EMPTY_CUSTOMER_SNAPSHOT,
  type CustomerSessionOptions,
  type CustomerSnapshot,
} from "@/lib/tracking/session";
import { AnchorOverlay } from "@/components/anchor-overlay";
import { SessionHolder } from "./session-holder";
import { CustomerOutcomeTracker, customerUntrackable, type AnchorOutcome } from "./usage";
import { AnnotatedPhoto } from "./annotated-photo";
import { FlipIcon } from "./icons";

// 고객 통화 화면: 내 카메라 미리보기(가득, object-cover) 위에 기사님 표시를 붙여 보여준다.
// 고객은 이 기능 때문에 아무것도 누를 필요가 없다 — 표시·카드·화살표 모두 자동이고 터치를 받지 않는다.
//  - 찾으면: 영상 위 빨간 핀·선 (사물에 붙어 움직임)
//  - 핀이 화면 밖: 가장자리 빨간 화살표 + 위쪽 큰 글씨 "화살표 쪽으로 폰을 돌려주세요"
//  - 못 찾음(0.8초 이상): 위쪽 큰 카드 — 기사님이 표시한 사진 + "기사님이 표시한 곳을 비춰주세요"
//    (무늬가 적거나 반복 무늬라 이 기준으로는 찾을 수 없으면 기다리지 않고 바로 카드)
// 한 화면에 한 가지: 카드·화살표 안내가 떠 있으면 연결 상태 문구는 숨긴다.
// 부모 크기를 가득 채운다 (고객 페이지는 fixed inset-0, 실험실은 폰 크기 상자).

export interface CustomerCallViewProps {
  /** 내 카메라 스트림 (미리보기 + 추적). 카메라를 바꾸면 새 스트림을 넘기면 된다 — 세션은 그대로 */
  stream: MediaStream | null;
  link: DataLink;
  /** 위쪽 상태 문구 (예: "기사님이 보고 있어요") */
  statusText: string;
  connected: boolean;
  onFlip?(): void;
  onHangup(): void;
  /** 앵커 하나가 끝날 때마다 추적 결과 요약 (지표) */
  onOutcome?(outcome: AnchorOutcome): void;
  /** 세션 옵션 추가 (실험실 계측용). 세션을 만들 때 한 번 읽는다 */
  sessionOptions?: Partial<Omit<CustomerSessionOptions, "video" | "link" | "fit">>;
  onSession?(session: CustomerAnchorSession | null): void;
  className?: string;
}

/** 화면 밖 화살표를 둘 안쪽 여백: 위 안내 글씨·아래 버튼을 피한다 (CSS px) */
const GUIDE_INSET = { top: 150, bottom: 150, left: 28, right: 28 };
/**
 * 추적기가 이 앵커로 아직 한 프레임도 못 봤으면(첫 갱신 전) 카드를 미룬다 — 기준 이미지 전송·Worker 시작에
 * 1초 가까이 걸릴 수 있어, 세션의 0.8초 카드 타이머만 따르면 찾기도 전에 카드가 잠깐 떴다 사라진다.
 * 추적기가 끝내 응답하지 않으면(Worker 실패 등) 이 시간이 지나면 카드를 보인다 (폴백은 반드시 뜬다).
 */
const CARD_FIRST_LOOK_MAX_MS = 2500;

interface ViewState {
  anchor: CustomerSnapshot["anchor"];
  cardUrl: string | null;
  showCard: boolean;
  arrow: boolean;
  /** 추적기가 이 앵커로 첫 갱신을 냈다 */
  looked: boolean;
  /** 지금 기사님 표시가 영상 위에 보인다 (tracking/weak) */
  shown: boolean;
  /** 이 기준으로는 스스로 찾을 수 없음 (무늬 부족·반복 무늬) → 카드를 기다리지 않고 바로 */
  untrackable: boolean;
}

function selectView(s: CustomerSnapshot): ViewState {
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

export function CustomerCallView({
  stream,
  link,
  statusText,
  connected,
  onFlip,
  onHangup,
  onOutcome,
  sessionOptions,
  onSession,
  className,
}: CustomerCallViewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [holder] = useState(
    () => new SessionHolder<CustomerAnchorSession, CustomerSnapshot>(EMPTY_CUSTOMER_SNAPSHOT),
  );
  const [view] = useState(() => holder.selector(selectView));
  const [getUpdate] = useState(() => () => holder.current()?.latestUpdate() ?? null);
  const snap = useSyncExternalStore(view.subscribe, view.getSnapshot, view.getServerSnapshot);
  const cb = useRef({ onOutcome, onSession, sessionOptions });
  const [cardForcedFor, setCardForcedFor] = useState<string | null>(null);

  useEffect(() => {
    cb.current = { onOutcome, onSession, sessionOptions };
  });

  // 첫 갱신이 너무 늦으면 카드를 막지 않는다
  const waitingFirstLook = snap.anchor && !snap.looked ? snap.anchor.id : null;
  useEffect(() => {
    if (!waitingFirstLook) return;
    const t = setTimeout(() => setCardForcedFor(waitingFirstLook), CARD_FIRST_LOOK_MAX_MS);
    return () => clearTimeout(t);
  }, [waitingFirstLook]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const s = new CustomerAnchorSession({ ...cb.current.sessionOptions, video, link, fit: "cover" });
    const outcome = new CustomerOutcomeTracker();
    const report = (o: AnchorOutcome | null) => {
      if (!o) return;
      try {
        cb.current.onOutcome?.(o);
      } catch (e) {
        console.warn("[customer-call] onOutcome 오류:", e);
      }
    };
    const offSnap = s.subscribe(() => report(outcome.observe(s.getSnapshot(), performance.now())));
    // 탭을 닫거나 다른 페이지로 갈 때도 마지막 앵커 결과를 남긴다 (keepalive 전송은 호출측)
    const onHide = () => report(outcome.finish(performance.now(), "ended"));
    window.addEventListener("pagehide", onHide);
    holder.set(s);
    cb.current.onSession?.(s);
    return () => {
      window.removeEventListener("pagehide", onHide);
      offSnap();
      report(outcome.finish(performance.now(), "ended"));
      holder.set(null);
      cb.current.onSession?.(null);
      s.destroy();
    };
  }, [holder, link]);

  // 카메라 스트림 (전/후면 전환 = 같은 <video>에 새 스트림 → 추적기가 알아서 새 영상으로 이어 간다)
  useEffect(() => {
    const v = videoRef.current;
    if (v && v.srcObject !== stream) v.srcObject = stream;
  }, [stream]);

  const cardAllowed = snap.looked || (!!snap.anchor && cardForcedFor === snap.anchor.id);
  // 카드: 못 찾은 채 0.8초(세션 규칙) 또는 이 기준으로는 찾을 수 없음(추적기가 알려 옴) → 바로
  const wantCard = (snap.showCard && cardAllowed) || snap.untrackable;
  const card = wantCard && !snap.arrow && snap.anchor && snap.cardUrl ? { anchor: snap.anchor, url: snap.cardUrl } : null;
  const arrow = !card && snap.arrow;
  // 표시가 화면에 보이는 동안은 "무엇을 보면 되는지"를 알려 준다
  const pinShown = !card && !arrow && !!snap.anchor && snap.shown;

  return (
    <div className={`relative h-full w-full overflow-hidden bg-black text-white [container-type:size] ${className ?? ""}`}>
      <video
        ref={videoRef}
        data-testid="cust-video"
        autoPlay
        playsInline
        muted
        className="absolute inset-0 h-full w-full object-cover"
      />
      <AnchorOverlay
        video={videoRef}
        fit="cover"
        anchor={snap.anchor}
        update={null}
        getUpdate={getUpdate}
        guideInset={GUIDE_INSET}
        className="anchor-overlay"
      />

      <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-col items-center px-3 pt-[max(12px,env(safe-area-inset-top))]">
        {card ? (
          <div
            data-testid="cust-card"
            role="alert"
            className="flex h-[50cqh] min-h-[300px] w-full max-w-md flex-col gap-3 rounded-3xl bg-white p-4 text-gray-900 shadow-2xl"
          >
            <p className="text-center text-[26px] font-extrabold leading-tight tracking-tight break-keep">
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
        ) : arrow ? (
          <p
            data-testid="cust-arrow-text"
            role="alert"
            className="w-full rounded-3xl bg-black/75 px-5 py-5 text-center text-[28px] font-extrabold leading-tight break-keep shadow-2xl backdrop-blur-sm"
          >
            화살표 쪽으로
            <br />
            폰을 돌려주세요
          </p>
        ) : (
          <span
            data-testid="cust-status"
            className={`mt-1 flex items-center gap-2 rounded-full px-5 py-2.5 text-center text-lg font-semibold break-keep shadow-lg ${
              pinShown ? "bg-white/95 text-gray-900" : connected ? "bg-green-600/90" : "bg-black/60"
            }`}
          >
            {pinShown && (
              <span className="h-4 w-4 shrink-0 rounded-full border-[3px] border-[#FF3B30] bg-white" aria-hidden="true" />
            )}
            {pinShown ? "빨간 동그라미를 봐주세요" : statusText}
          </span>
        )}
      </div>

      <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-5 bg-gradient-to-t from-black/70 to-transparent px-6 pt-10 pb-[max(40px,env(safe-area-inset-bottom))]">
        {onFlip && (
          <button
            type="button"
            onClick={onFlip}
            aria-label="카메라 전환"
            className="flex h-16 w-16 items-center justify-center rounded-full bg-white/25 text-white active:bg-white/40"
          >
            <FlipIcon className="h-7 w-7" />
          </button>
        )}
        <button
          type="button"
          data-testid="cust-hangup"
          onClick={onHangup}
          className="h-16 rounded-full bg-red-600 px-10 text-xl font-bold text-white active:opacity-80"
        >
          종료
        </button>
      </div>
    </div>
  );
}
