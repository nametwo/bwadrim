"use client";

import Link from "next/link";
import type { ComponentProps } from "react";
import { requestMicAhead } from "@/lib/webrtc/mic-ahead";

// 진행 중인 상담 '이어하기': 누르는 탭 안에서 마이크를 미리 요청해, 세션 화면이 뜨자마자 통화 대기를 시작한다 (CALL-01)
export function MicAheadLink({ roomId, ...rest }: { roomId: string } & ComponentProps<typeof Link>) {
  return <Link {...rest} onClick={() => requestMicAhead(roomId)} />;
}
