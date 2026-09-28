import { errorContext } from "./client-error";
import type { Telemetry } from "./telemetry";

// 화면(페이지) 요약 call_summary (DATA-07). 실패 화면 없이 조용히 끝나는 일
// (버튼을 안 누르고 떠남, 잠깐 끊김, 도구 전달 실패, 답 없이 닫음…)은 여기에만 남는다.
// 화면이 숨겨질 때(폰 잠금·앱 전환)와 떠날 때(pagehide) sendBeacon으로 보낸다 — 서버는 pid마다 한 줄로 덮어쓴다.
// 폰에 저장하지 않는다(NFR-04). 값은 숫자·짧은 글자만 (서버가 16KB에서 자른다).

type Value = string | number | boolean | null;

const MIN_FLUSH_GAP_MS = 2000;

export class CallReport {
  private fields: Record<string, Value> = {};
  private counts: Record<string, number> = {};
  private phase = "init";
  private phaseAt = Date.now();
  private readonly openedAt = Date.now();
  private phaseMs: Record<string, number> = {};
  private hiddenCount = 0;
  private hiddenMs = 0;
  private hiddenSince: number | null = null;
  private lastFlush = 0;
  private extra: (() => Record<string, unknown>) | null = null;
  private cleanup: (() => void) | null = null;
  private disposed = false;

  constructor(
    private tel: Telemetry,
    base: Record<string, Value> = {},
  ) {
    this.fields = { ...base };
  }

  // 화면이 숨겨질 때·떠날 때 자동으로 보낸다. 해제 함수는 마지막으로 한 번 보내고 듣기를 멈춘다
  // (엔지니어 화면은 페이지 이동 없이 대시보드로 가므로 pagehide가 안 온다).
  // 같은 pid로 덮어쓰므로 개발 모드에서 두 번 붙었다 떨어져도 마지막 요약만 남는다
  listen(): () => void {
    if (typeof window === "undefined") return () => {};
    this.cleanup?.();
    this.disposed = false;
    const onVis = () => {
      if (document.visibilityState === "hidden") {
        this.hiddenCount++;
        this.hiddenSince = Date.now();
        this.flush("hidden", true);
      } else if (this.hiddenSince !== null) {
        this.hiddenMs += Date.now() - this.hiddenSince;
        this.hiddenSince = null;
      }
    };
    const onHide = () => this.flush("pagehide", true);
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", onHide);
    this.cleanup = () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", onHide);
    };
    return () => {
      this.flush("unmount", true);
      this.dispose();
    };
  }

  // 통화 관찰값(CallSession.telemetry())처럼 보낼 때마다 새로 읽을 값
  attach(read: (() => Record<string, unknown>) | null) {
    this.extra = read;
  }

  setPhase(phase: string) {
    if (phase === this.phase) return;
    const now = Date.now();
    this.phaseMs[this.phase] = (this.phaseMs[this.phase] ?? 0) + (now - this.phaseAt);
    this.phase = phase;
    this.phaseAt = now;
    errorContext.phase = phase;
  }

  set(key: string, value: Value) {
    this.fields[key] = value;
  }

  inc(key: string, by = 1) {
    this.counts[key] = (this.counts[key] ?? 0) + by;
  }

  snapshot(exitHint?: string): Record<string, unknown> {
    const now = Date.now();
    const phaseMs = { ...this.phaseMs, [this.phase]: (this.phaseMs[this.phase] ?? 0) + (now - this.phaseAt) };
    // 짧은 단계(1초 미만)는 빼서 요약을 작게
    for (const k of Object.keys(phaseMs)) if (phaseMs[k] < 1000) delete phaseMs[k];
    let extra: Record<string, unknown> = {};
    try {
      extra = this.extra?.() ?? {};
    } catch {
      // 관찰값을 못 읽어도 요약은 보낸다
    }
    return {
      ...this.fields,
      exit: this.fields.exit ?? exitHint ?? null,
      phase: this.phase,
      ms_on_page: now - this.openedAt,
      phase_ms: phaseMs,
      hidden_count: this.hiddenCount,
      hidden_ms: this.hiddenMs + (this.hiddenSince === null ? 0 : now - this.hiddenSince),
      counts: this.counts,
      ...extra,
    };
  }

  // 보내기. final이면(떠나는 중) 간격 제한 없이 바로
  flush(exitHint?: string, final = false) {
    if (this.disposed) return;
    const now = Date.now();
    if (!final && now - this.lastFlush < MIN_FLUSH_GAP_MS) return;
    this.lastFlush = now;
    this.tel.beacon("call_summary", this.snapshot(exitHint));
  }

  dispose() {
    this.cleanup?.();
    this.cleanup = null;
    this.disposed = true;
  }
}
