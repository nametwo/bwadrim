// 앵커 세션(EngineerAnchorSession·CustomerAnchorSession)을 React에 물리는 작은 외부 저장소.
//
// 세션은 <video> 요소가 있어야 만들 수 있어서 effect 안에서 생긴다. effect 안에서 setState로 세션을 넘기면
// 렌더가 한 번 더 돈다(react-hooks/set-state-in-effect). 대신 이 홀더에 넣고 useSyncExternalStore로 읽는다:
//
//   const [holder] = useState(() => new SessionHolder<EngineerAnchorSession, EngineerSnapshot>(EMPTY_ENGINEER_SNAPSHOT));
//   const snap = useSyncExternalStore(holder.subscribe, holder.getSnapshot, holder.getServerSnapshot);
//   useEffect(() => { const s = new EngineerAnchorSession(...); holder.set(s); return () => { holder.set(null); s.destroy(); }; }, []);
//
// 세션이 바뀌거나(null 포함) 세션 스냅샷이 바뀌면 구독자에게 알린다.

function shallowEqual(a: object, b: object): boolean {
  const ka = Object.keys(a) as (keyof typeof a)[];
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (!Object.is(a[k], b[k])) return false;
  return true;
}

export interface SnapshotSource<S> {
  subscribe(listener: () => void): () => void;
  getSnapshot(): S;
}

export class SessionHolder<T extends SnapshotSource<S>, S> {
  private session: T | null = null;
  private off: (() => void) | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly empty: S) {}

  current(): T | null {
    return this.session;
  }

  set(session: T | null): void {
    if (session === this.session) return;
    this.off?.();
    this.off = null;
    this.session = session;
    if (session) this.off = session.subscribe(() => this.notify());
    this.notify();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): S => (this.session ? this.session.getSnapshot() : this.empty);

  getServerSnapshot = (): S => this.empty;

  /**
   * 스냅샷의 일부만 보는 저장소 (useSyncExternalStore용). 고른 필드가 얕게 같으면 이전 객체를 그대로 돌려준다 →
   * 추적 갱신(20~30fps)마다 화면 전체를 다시 그리지 않는다. 오버레이는 getUpdate로 최신 H를 직접 읽는다.
   */
  selector<V extends object>(select: (s: S) => V): {
    subscribe: (listener: () => void) => () => void;
    getSnapshot: () => V;
    getServerSnapshot: () => V;
  } {
    let last: V | null = null;
    const server = select(this.empty);
    return {
      subscribe: this.subscribe,
      getSnapshot: () => {
        const next = select(this.getSnapshot());
        if (last && shallowEqual(last, next)) return last;
        last = next;
        return next;
      },
      getServerSnapshot: () => server,
    };
  }

  private notify() {
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch (e) {
        console.warn("[session-holder] 구독자 오류:", e);
      }
    }
  }
}
