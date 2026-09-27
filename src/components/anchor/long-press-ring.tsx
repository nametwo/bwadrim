import styles from "./long-press-ring.module.css";

// 길게 누르는 동안 손가락 둘레에 차오르는 원 (CALL-14). 다 차면 핀이 꽂힌다.
// 좌표는 부모(영상 컨테이너) 기준 CSS px. 누를 때마다 새로 그려져 처음부터 차오른다.
const SIZE = 72;
const R = 30;
const C = 2 * Math.PI * R;

export function LongPressRing({ x, y, durationMs }: { x: number; y: number; durationMs: number }) {
  return (
    <svg
      aria-hidden="true"
      width={SIZE}
      height={SIZE}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      className={styles.ring}
      style={{ left: x - SIZE / 2, top: y - SIZE / 2 }}
    >
      <circle cx={SIZE / 2} cy={SIZE / 2} r={R} className={styles.track} />
      <circle
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={R}
        className={styles.fill}
        strokeDasharray={C}
        strokeDashoffset={C}
        style={{ animationDuration: `${durationMs}ms`, ["--c" as string]: C }}
      />
    </svg>
  );
}
