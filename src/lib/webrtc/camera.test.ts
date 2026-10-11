import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { switchCamera } from "./camera";

// 카메라 전환 단계 (JOIN-07·CALL-10): 새 카메라(켠 채) → 새 카메라(끄고) → 원래 카메라 → 아무 카메라.
// node에는 MediaStream·getUserMedia가 없어 흉내 낸다.

class FakeTrack {
  readyState: "live" | "ended" = "live";
  constructor(
    readonly kind: "video" | "audio",
    readonly label: string,
  ) {}
  stop() {
    this.readyState = "ended";
  }
}

class FakeStream {
  constructor(private readonly tracks: FakeTrack[] = []) {}
  getTracks() {
    return this.tracks;
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === "video");
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === "audio");
  }
}

type Answer = string | DOMException; // 문자열이면 그 이름의 카메라를 연다
let answers: Answer[] = [];
let asked: MediaStreamConstraints[] = [];

beforeEach(() => {
  answers = [];
  asked = [];
  vi.stubGlobal("MediaStream", FakeStream);
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: async (c: MediaStreamConstraints) => {
        asked.push(c);
        const a = answers.shift() ?? new DOMException("no more", "NotReadableError");
        if (a instanceof DOMException) throw a;
        return new FakeStream([new FakeTrack("video", a)]);
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function current() {
  const video = new FakeTrack("video", "back");
  const mic = new FakeTrack("audio", "mic");
  return { stream: new FakeStream([video, mic]) as unknown as MediaStream, video, mic };
}

const fail = () => new DOMException("busy", "NotReadableError");
const videoLabel = (s: MediaStream | null) => (s?.getVideoTracks()[0] as unknown as FakeTrack | undefined)?.label;

describe("switchCamera", () => {
  it("1) 지금 카메라를 켠 채 새 카메라를 열고, 마이크는 그대로", async () => {
    const c = current();
    answers = ["front"];
    const r = await switchCamera(c.stream, "environment");
    expect(r).toMatchObject({ ok: true, facing: "user" });
    expect(videoLabel(r.stream)).toBe("front");
    expect(r.stream?.getAudioTracks()[0]).toBe(c.mic);
    expect(c.video.readyState).toBe("ended");
    expect(asked).toEqual([{ video: { facingMode: "user" }, audio: false }]);
  });

  it("탭이 있어야 바꿀 수 있는 폰이면 지금 카메라를 그대로 두고 needs_tap", async () => {
    const c = current();
    answers = [new DOMException("tap", "NotAllowedError")];
    const r = await switchCamera(c.stream, "environment");
    expect(r).toEqual({ ok: false, reason: "needs_tap", stream: c.stream, facing: "environment" });
    expect(c.video.readyState).toBe("live");
  });

  it("2) 두 카메라를 같이 못 열면 지금 카메라를 끄고 연다", async () => {
    const c = current();
    answers = [fail(), "front"];
    const r = await switchCamera(c.stream, "environment");
    expect(r).toMatchObject({ ok: true, facing: "user" });
    expect(videoLabel(r.stream)).toBe("front");
  });

  it("3) 새 카메라가 안 열리면 원래 카메라로 되돌린다", async () => {
    const c = current();
    answers = [fail(), fail(), "back-again"];
    const r = await switchCamera(c.stream, "environment");
    expect(r).toMatchObject({ ok: false, reason: "failed", facing: "environment" });
    expect(videoLabel(r.stream)).toBe("back-again");
    expect(asked[2]).toEqual({ video: { facingMode: "environment" }, audio: false });
  });

  it("4) 원래 카메라도 안 열리면 방향을 따지지 않고 아무 카메라나 연다 (방향은 원래 값)", async () => {
    const c = current();
    answers = [fail(), fail(), fail(), "any"];
    const r = await switchCamera(c.stream, "user");
    expect(r).toMatchObject({ ok: false, reason: "failed", facing: "user" });
    expect(videoLabel(r.stream)).toBe("any");
    expect(r.stream?.getAudioTracks()[0]).toBe(c.mic);
    expect(asked[3]).toEqual({ video: true });
  });

  it("아무 카메라도 못 열면 stream이 null — 영상이 꺼진 채다", async () => {
    const c = current();
    answers = [fail(), fail(), fail(), fail()];
    const r = await switchCamera(c.stream, "environment");
    expect(r).toEqual({ ok: false, reason: "failed", stream: null, facing: "environment" });
    expect(c.video.readyState).toBe("ended");
    expect(c.mic.readyState).toBe("live");
  });
});
