"use client";

import { useCallback, useState } from "react";
import { GuideDpad } from "@/components/guide-dpad";
import { GuideOverlay, useGuideReceiver } from "@/components/guide-overlay";
import { isGuideMsg, type GuideMsg } from "@/lib/webrtc/guide";

const LATENCIES = [
  { ms: 0, label: "없음" },
  { ms: 300, label: "0.3초" },
  { ms: 800, label: "0.8초" },
];

const segBtn =
  "rounded-lg border border-call-border px-3 py-1.5 aria-pressed:border-guide-signal aria-pressed:text-guide-signal";

// 엔지니어 ↔ 고객을 한 화면에 두고, DataChannel 대신 setTimeout으로 지연만 흉내 낸다 (CALL-15).
export function GuideLab() {
  const [latency, setLatency] = useState(300);
  const [drop, setDrop] = useState(false);
  const [stillHint, setStillHint] = useState(false);
  const [last, setLast] = useState("");
  const { view, receive } = useGuideReceiver({ stillHint });

  const onSend = useCallback(
    (msg: GuideMsg) => {
      const wire = JSON.stringify(msg);
      setLast(wire);
      if (drop) return;
      setTimeout(() => {
        const m: unknown = JSON.parse(wire);
        if (isGuideMsg(m)) receive(m);
      }, latency);
    },
    [drop, latency, receive],
  );

  return (
    <main className="flex min-h-dvh flex-col gap-4 bg-call-bg p-3 text-call-text sm:p-6">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h1 className="text-base font-bold">방향 지시 실험실</h1>
        <p className="text-xs text-call-text-secondary">십자키를 누르고 있는 동안만 고객 화면에 표시돼요</p>
      </header>

      <div className="flex items-start justify-center gap-3 md:gap-8">
        <section className="min-w-0 flex-1 md:max-w-[420px]">
          <h2 className="mb-2 text-xs font-semibold text-call-text-secondary">엔지니어 폰</h2>
          <div className="flex flex-col items-center gap-4">
            <div className="relative grid aspect-[3/4] w-full place-items-center rounded-2xl bg-call-surface text-sm text-call-text-secondary">
              고객 영상 자리
            </div>
            <GuideDpad onSend={onSend} />
          </div>
          <p className="mt-2 text-xs text-call-text-secondary">
            누른 채 굴려서 방향 바꾸기 · 가운데 위(+) 가까이, 아래(−) 멀리 · PC는 방향키, = 가까이, - 멀리
          </p>
        </section>

        <section className="flex w-[30vw] flex-none flex-col md:w-auto">
          <h2 className="mb-2 text-xs font-semibold text-call-text-secondary">고객 폰</h2>
          <div className="relative aspect-[9/19.5] w-full overflow-hidden rounded-[22px] bg-call-surface ring-1 ring-call-border [--guide-bottom:8px] [--guide-top:8px] md:h-[70dvh] md:max-h-[760px] md:w-auto">
            <div className="absolute inset-x-0 top-1/2 grid aspect-[3/4] -translate-y-1/2 place-items-center bg-call-control text-xs text-call-text-secondary">
              카메라 화면
            </div>
            <div className="absolute bottom-[4%] left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-danger px-[9%] py-[2.5%] text-[clamp(8px,2.6vw,15px)] font-bold text-on-primary">
              통화 종료
            </div>
            <GuideOverlay view={view} />
          </div>
        </section>
      </div>

      <section className="mx-auto flex w-full max-w-3xl flex-col gap-3 rounded-xl bg-call-surface p-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="w-24 text-call-text-secondary">지연</span>
          {LATENCIES.map((l) => (
            <button key={l.ms} type="button" onClick={() => setLatency(l.ms)} aria-pressed={latency === l.ms} className={segBtn}>
              {l.label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={stillHint} onChange={(e) => setStillHint(e.target.checked)} className="size-4 accent-guide-signal" />
          손 떼면 &ldquo;그대로요&rdquo;를 잠깐 띄우기
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={drop} onChange={(e) => setDrop(e.target.checked)} className="size-4 accent-guide-signal" />
          <span>
            전송 끊김 테스트 <span className="text-call-text-secondary">(누른 채로 켜면 고객 화면은 1.5초 뒤 스스로 지워요)</span>
          </span>
        </label>
        <p className="text-xs text-call-text-secondary">
          톡 짧게 눌러도 고객 화면엔 1초는 보여요. 누르는 동안 0.4초마다 신호를 다시 보내요.
        </p>
        <code className="block truncate rounded bg-call-bg px-2 py-1 text-xs text-call-text-secondary">{last || "보낸 메시지 없음"}</code>
      </section>
    </main>
  );
}
