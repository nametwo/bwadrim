// 고객 카메라 제어: 전·후면 전환과 손전등 (요구사항 JOIN-07, CALL-10, CALL-11).
// 엔지니어가 원격으로 명령하거나 고객이 🔄를 누르면 고객 폰에서 실행된다.

export type Facing = "environment" | "user";

// 고객 → 엔지니어: 지금 카메라 상태. 명령에 대한 결과로도 보낸다
export interface CameraState {
  facing: Facing;
  torch: boolean;
  torchSupported: boolean;
  // 방금 명령이 실패했으면 이유. needs_tap: 폰이 고객의 탭 없이는 카메라를 못 바꾼다(아이폰 등)
  error?: "failed" | "needs_tap";
}

// 엔지니어 → 고객
export type CameraCommand = { t: "cam"; cmd: "flip" } | { t: "cam"; cmd: "torch"; on: boolean };

export function parseCameraCommand(msg: unknown): CameraCommand | null {
  const m = msg as Record<string, unknown> | null;
  if (m?.t !== "cam") return null;
  if (m.cmd === "flip") return { t: "cam", cmd: "flip" };
  if (m.cmd === "torch" && typeof m.on === "boolean") {
    return { t: "cam", cmd: "torch", on: m.on };
  }
  return null;
}

export function parseCameraState(msg: unknown): CameraState | null {
  const m = msg as Record<string, unknown> | null;
  if (m?.t !== "cam-state") return null;
  if (
    (m.facing !== "environment" && m.facing !== "user") ||
    typeof m.torch !== "boolean" ||
    typeof m.torchSupported !== "boolean"
  ) {
    return null;
  }
  const error = m.error === "failed" || m.error === "needs_tap" ? m.error : undefined;
  return { facing: m.facing, torch: m.torch, torchSupported: m.torchSupported, error };
}

async function openCamera(facing: Facing): Promise<MediaStreamTrack> {
  const s = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: facing },
    audio: false,
  });
  return s.getVideoTracks()[0];
}

export type SwitchResult =
  | { ok: true; stream: MediaStream; facing: Facing }
  // stream: 실패 후 쓸 스트림(원래 카메라). null이면 카메라를 다시 열지 못했다
  | {
      ok: false;
      reason: "failed" | "needs_tap";
      stream: MediaStream | null;
      facing: Facing;
    };

// 반대쪽 카메라로 바꾼 새 스트림(기존 마이크 유지)을 돌려준다.
// 1) 지금 카메라를 켠 채 새 카메라를 연다(끊김 없음) 2) 안 되면 지금 카메라를 끄고 연다
// (카메라 두 개를 동시에 못 여는 폰) 3) 그래도 안 되면 원래 카메라를 다시 연다.
export async function switchCamera(
  current: MediaStream,
  from: Facing,
): Promise<SwitchResult> {
  const to: Facing = from === "environment" ? "user" : "environment";
  const audio = current.getAudioTracks();
  const withVideo = (t: MediaStreamTrack) => new MediaStream([t, ...audio]);

  try {
    const track = await openCamera(to);
    current.getVideoTracks().forEach((t) => t.stop());
    return { ok: true, stream: withVideo(track), facing: to };
  } catch (e) {
    // 사용자 탭 없이는 카메라를 못 바꾸는 폰 — 지금 카메라는 그대로다
    if (e instanceof DOMException && e.name === "NotAllowedError") {
      return { ok: false, reason: "needs_tap", stream: current, facing: from };
    }
  }

  current.getVideoTracks().forEach((t) => t.stop());
  try {
    return { ok: true, stream: withVideo(await openCamera(to)), facing: to };
  } catch {
    try {
      const back = await openCamera(from);
      return { ok: false, reason: "failed", stream: withVideo(back), facing: from };
    } catch {
      return { ok: false, reason: "failed", stream: null, facing: from };
    }
  }
}

export function torchSupported(track: MediaStreamTrack | undefined): boolean {
  if (!track || typeof track.getCapabilities !== "function") return false;
  return (track.getCapabilities() as { torch?: boolean }).torch === true;
}

// 손전등 켜기/끄기. 실제로 바뀌었는지 돌려준다
export async function setTorch(
  track: MediaStreamTrack | undefined,
  on: boolean,
): Promise<boolean> {
  if (!track || !torchSupported(track)) return false;
  try {
    await track.applyConstraints({
      advanced: [{ torch: on } as MediaTrackConstraintSet],
    });
    return true;
  } catch {
    return false;
  }
}
