// 통화 중 화면 꺼짐 방지. 고객은 폰을 비추기만 하고 화면을 건드리지 않아 자동 잠금으로 끊기기 쉽다.
// 사용자 탭 핸들러 안에서 호출할 것. 지원하지 않거나 거부되면(저전력 모드 등) 조용히 넘어간다.
// 탭을 벗어나면 브라우저가 풀어 버리므로 다시 보일 때 재요청한다. 반환 함수로 해제.
export function keepScreenOn(): () => void {
  let lock: WakeLockSentinel | null = null;
  let released = false;

  const request = async () => {
    if (released || !("wakeLock" in navigator)) return;
    if (document.visibilityState !== "visible") return;
    try {
      const next = await navigator.wakeLock.request("screen");
      if (released) next.release().catch(() => {});
      else lock = next;
    } catch {
      lock = null;
    }
  };

  const onVisibility = () => {
    if (document.visibilityState === "visible" && (!lock || lock.released)) {
      request();
    }
  };

  document.addEventListener("visibilitychange", onVisibility);
  request();

  return () => {
    released = true;
    document.removeEventListener("visibilitychange", onVisibility);
    lock?.release().catch(() => {});
    lock = null;
  };
}
