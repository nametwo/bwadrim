// 고객 부르기 화면(E04, ROOM-13) 큰 제목이 지금 어느 단계를 말할지. 화면 없이 단위 테스트한다(wait-status.test.ts).
//  - failed: 연결에 실패했어요
//  - denied: 고객님 카메라가 막혀 있어요
//  - left: 고객님을 다시 기다리고 있어요 (있다가 나갔거나, 새로고침 뒤 채널에 없음)
//  - coming: 곧 연결돼요 (채널에 있거나 막 카메라를 켬)
//  - opened: 카메라를 켜기를 기다리고 있어요 (링크만 열었음)
//  - waiting: 링크를 열기를 기다리고 있어요
// 카메라 허용 기록(camera_granted)은 지워지지 않아서 그것만 보면 고객이 나가도 '곧 연결돼요'가 남는다.
// 그래서 채널에 지금 있는지(presence)와 기록이 얼마나 오래됐는지를 같이 본다.

/** 카메라를 켠 뒤 채널에 들어오기까지 이만큼은 기다려 준다(초). 그동안은 '나감'으로 보지 않는다 */
export const JOINING_GRACE_SEC = 20;

export type WaitKind = "failed" | "denied" | "left" | "coming" | "opened" | "waiting";

export type WaitInput = {
  /** 연결이 완전히 실패했다 (CALL-07) */
  failed: boolean;
  /** 가장 최근 카메라 결과 (getJoinProgress) */
  cam: "granted" | "denied" | null;
  /** 고객이 지금 채널에 있다 (presence) */
  peerPresent: boolean;
  /** 이 화면에서 고객이 채널에 있다가 나가는 것을 봤다 (연결 전 '끝내기' 포함) */
  peerLeft: boolean;
  /** 이번 통화 대기에서 채널 presence를 한 번이라도 받았다 (받기 전엔 채널에 없다고 단정하지 않는다) */
  presenceKnown: boolean;
  /** 고객과 연결된 적 있는 상담 */
  everConnected: boolean;
  linkOpened: boolean;
  /** 마지막 카메라 허용 기록이 몇 초 전인지. 모르면 null */
  cameraAgoSec: number | null;
};

export function waitHead(i: WaitInput): { kind: WaitKind; coming: boolean } {
  // 막 카메라를 켰다 — 채널에 들어오는 중일 수 있다
  const joining = i.cam === "granted" && i.cameraAgoSec !== null && i.cameraAgoSec < JOINING_GRACE_SEC;
  const left =
    !i.peerPresent &&
    (i.peerLeft || (i.presenceKnown && (i.everConnected || (i.cam === "granted" && !joining))));
  const coming = i.peerPresent || (i.cam === "granted" && !left);
  const kind: WaitKind = i.failed
    ? "failed"
    : i.cam === "denied"
      ? "denied"
      : left
        ? "left"
        : coming
          ? "coming"
          : i.linkOpened
            ? "opened"
            : "waiting";
  return { kind, coming };
}
