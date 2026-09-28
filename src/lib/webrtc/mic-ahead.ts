import { keepScreenOn } from "@/lib/wake-lock";

// 엔지니어 마이크를 대시보드의 탭(사용자 제스처) 안에서 미리 요청해 두고, 세션 화면이 이어받는다 (CALL-01).
// '새 A/S 시작'·'이어하기'를 누르면 세션 화면이 뜨자마자 통화 대기를 시작해 '연결 준비'를 또 누를 필요가 없다.
// 화면 이동은 같은 문서 안(Next 클라이언트 이동)이라 이 모듈의 값이 남아 있다. 새로고침하면 사라진다 → 세션 화면은 버튼을 보여 준다.

type Ahead = {
  /** 'new'(새 세션, 아직 id 모름) 또는 세션 id */
  key: string;
  mic: Promise<MediaStream | null>;
  releaseWakeLock: () => void;
};

let pending: Ahead | null = null;

/** 세션 화면이 이 시간 안에 가져가지 않으면(만들기 실패 등) 마이크와 화면 켜짐을 푼다 */
const TAKE_WITHIN_MS = 30_000;

function discard(a: Ahead) {
  a.mic.then((s) => s?.getTracks().forEach((t) => t.stop()));
  a.releaseWakeLock();
}

/** 반드시 탭 핸들러 안에서 부를 것 (iOS는 제스처 없이 마이크를 묻지 않는다) */
export function requestMicAhead(key: string) {
  if (pending) discard(pending);
  const mic: Promise<MediaStream | null> = navigator.mediaDevices?.getUserMedia
    ? navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null) // 거부·없음 — 보기만(CALL-02)
    : Promise.resolve(null);
  const mine: Ahead = { key, mic, releaseWakeLock: keepScreenOn() };
  pending = mine;
  setTimeout(() => {
    if (pending === mine) {
      pending = null;
      discard(mine);
    }
  }, TAKE_WITHIN_MS);
}

/** 이 세션(또는 방금 만든 새 세션) 몫으로 미리 요청해 둔 마이크를 가져간다. 없으면 null */
export function takeMicAhead(roomId: string): Omit<Ahead, "key"> | null {
  const a = pending;
  if (!a || (a.key !== "new" && a.key !== roomId)) return null;
  pending = null;
  return { mic: a.mic, releaseWakeLock: a.releaseWakeLock };
}
