"use client";

import { useEffect, useState } from "react";
import { formatClock } from "@/lib/format";

/** 연결된 뒤 흐른 시간 '3:12' (피그마 '통화 중 · 03:12'). 1초마다 자기만 다시 그린다(통화 화면 전체를 다시 그리지 않게) */
export function CallTimer({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <span className="tabular-nums">{formatClock((now - since) / 1000)}</span>;
}
