import { describe, expect, it } from "vitest";
import { waitHead, type WaitInput } from "./wait-status";

// 채널에 이미 들어와 presence를 받은 뒤, 링크를 열고 카메라를 막 켠 고객
const base: WaitInput = {
  failed: false,
  cam: null,
  peerPresent: false,
  peerLeft: false,
  presenceKnown: true,
  everConnected: false,
  linkOpened: true,
  cameraAgoSec: null,
};

describe("고객 부르기 화면 제목 (ROOM-13)", () => {
  it("카메라를 켜고 채널에 있으면 곧 연결", () => {
    expect(waitHead({ ...base, cam: "granted", cameraAgoSec: 3, peerPresent: true })).toEqual({ kind: "coming", coming: true });
    // 카메라 기록이 오래돼도 지금 채널에 있으면 곧 연결
    expect(waitHead({ ...base, cam: "granted", cameraAgoSec: 600, peerPresent: true })).toEqual({ kind: "coming", coming: true });
  });

  it("채널에 있다가 나가면 다시 기다림 (카메라 기록이 막 생겼어도)", () => {
    expect(waitHead({ ...base, cam: "granted", cameraAgoSec: 5, peerLeft: true })).toEqual({ kind: "left", coming: false });
    expect(waitHead({ ...base, everConnected: true, cam: "granted", cameraAgoSec: 600, peerLeft: true }).kind).toBe("left");
  });

  it("새로고침 뒤: 연결된 적 있는 상담이고 채널에 없으면 다시 기다림 (링크를 연 단계보다 먼저)", () => {
    expect(waitHead({ ...base, everConnected: true })).toEqual({ kind: "left", coming: false });
    expect(waitHead({ ...base, everConnected: true, cam: "granted", cameraAgoSec: 3600 }).kind).toBe("left");
  });

  it("카메라를 막 켰고(20초 안) 아직 채널에 안 들어왔으면 곧 연결", () => {
    expect(waitHead({ ...base, cam: "granted", cameraAgoSec: 5 })).toEqual({ kind: "coming", coming: true });
  });

  it("카메라를 켠 지 오래됐는데 채널에 없으면 다시 기다림", () => {
    expect(waitHead({ ...base, cam: "granted", cameraAgoSec: 60 })).toEqual({ kind: "left", coming: false });
    // 기록 시각을 못 읽었으면(null) 막 켰다고 보지 않는다
    expect(waitHead({ ...base, cam: "granted", cameraAgoSec: null }).kind).toBe("left");
  });

  it("presence를 받기 전에는 채널에 없다고 단정하지 않는다", () => {
    expect(waitHead({ ...base, presenceKnown: false, cam: "granted", cameraAgoSec: 600 })).toEqual({ kind: "coming", coming: true });
    expect(waitHead({ ...base, presenceKnown: false, everConnected: true }).kind).toBe("opened");
    expect(waitHead({ ...base, presenceKnown: false, linkOpened: false }).kind).toBe("waiting");
  });

  it("링크만 열었으면 카메라 켜기를, 아무것도 없으면 링크 열기를 기다림", () => {
    expect(waitHead(base)).toEqual({ kind: "opened", coming: false });
    expect(waitHead({ ...base, linkOpened: false })).toEqual({ kind: "waiting", coming: false });
  });

  it("연결 실패가 가장 먼저, 그다음 카메라 막힘", () => {
    expect(waitHead({ ...base, failed: true, cam: "denied", peerLeft: true }).kind).toBe("failed");
    expect(waitHead({ ...base, failed: true, cam: "granted", peerPresent: true })).toEqual({ kind: "failed", coming: true });
    expect(waitHead({ ...base, cam: "denied", peerLeft: true, everConnected: true })).toEqual({ kind: "denied", coming: false });
    expect(waitHead({ ...base, cam: "denied", peerPresent: true }).kind).toBe("denied");
  });
});
