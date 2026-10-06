"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { textFieldClass } from "@/components/ui/text-field";
import { LABEL_MAX } from "@/lib/recipient-label";
import { nameRecipient } from "./actions";

// 받는 분 이름표 (ROOM-16). 링크를 보낸 뒤(문자·카톡·공유·복사 모두) 보인다.
//  - 이름표가 있으면: '받는 분  김 사장님  고치기' 한 줄
//  - 아직 없으면: '누구에게 보냈나요?' 입력칸 하나. 안 적어도 된다(누를 것이 아니므로 파랑 없이 회색 '저장')
// 이름은 엔지니어 마음대로(사람 이름·상호). auto(카톡 1:1 방이 이어진 상담)면 같은 분께 다시 카톡을 보낼 때 저절로 붙는다.
// 문자 등은 이 상담에만 붙는다. 없으면 상담 목록에 시각으로 보인다.
// label은 서버에서 읽은 이름(대기 화면은 3초마다 다시 읽는다). 카톡 알림이 와서 방이 바뀌면 쓰는 쪽이 key로 새로 그린다
export function RecipientCard({ roomId, label: server, auto }: { roomId: string; label: string | null; auto: boolean }) {
  // 여기서 저장한 이름. 서버 값이 저장할 때 그대로인 동안만 이것을 보이고,
  // 서버 값이 바뀌면(따라잡았거나 다른 곳에서 고침) 서버 값을 따른다. 고치는 중인 칸은 건드리지 않는다
  const [local, setLocal] = useState<{ label: string; over: string | null } | null>(null);
  const shown = local && server === local.over ? local.label : (server ?? local?.label ?? null);
  const [renaming, setRenaming] = useState(false);
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<"auth" | "retry" | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!value.trim() || pending) return;
    setPending(true);
    setFailure(null);
    const r = await nameRecipient(roomId, value).catch(() => null);
    setPending(false);
    if (r?.ok) {
      setLocal({ label: r.label, over: server });
      setRenaming(false);
      setValue("");
      // 키보드를 내린다
      (document.activeElement as HTMLElement | null)?.blur();
    } else {
      setFailure(r?.reason === "auth" ? "auth" : "retry");
    }
  }

  if (shown !== null && !renaming) {
    return (
      <section data-testid="recipient" data-state="known" className="flex items-center gap-3 rounded-3xl bg-bg-subtle py-2 pr-2 pl-5">
        <span className="flex-none text-body-m text-text-secondary">받는 분</span>
        <span className="min-w-0 flex-1 truncate text-right text-label-l text-text-primary" data-testid="recipient-label">
          {shown}
        </span>
        <Button
          variant="ghost"
          size="m"
          onClick={() => {
            setValue(shown);
            setFailure(null);
            setRenaming(true);
          }}
          data-testid="recipient-edit"
        >
          고치기
        </Button>
      </section>
    );
  }

  return (
    <form
      data-testid="recipient"
      data-state={renaming ? "edit" : "ask"}
      onSubmit={save}
      className="flex flex-col gap-3 rounded-3xl bg-bg-subtle p-5"
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-title-s">{renaming ? "받는 분 이름 고치기" : "누구에게 보냈나요?"}</h2>
        <p className="text-body-m text-text-secondary">
          {renaming
            ? auto
              ? "이분께 보낸 상담의 이름이 모두 바뀌어요."
              : "이 상담의 이름이 바뀌어요."
            : auto
              ? "처음 보내는 분이에요. 이름을 적어 두면 다음부터 저절로 나와요."
              : "이름을 적어 두면 상담 목록에 이 이름으로 보여요."}
        </p>
      </div>
      <div className="flex gap-2">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          maxLength={LABEL_MAX}
          placeholder="예: 김 사장님, 역삼점"
          aria-label="받는 분 이름"
          aria-invalid={!!failure || undefined}
          autoComplete="off"
          enterKeyHint="done"
          data-testid="recipient-input"
          // '고치기'를 눌렀으면 바로 칠 수 있게. 처음 묻는 칸은 안 적어도 되니 키보드를 올리지 않는다
          autoFocus={renaming}
          className={textFieldClass({ onCard: true })}
        />
        {/* 누르는 순간 입력칸에서 커서가 빠지면 아래에 붙는 버튼 묶음(BottomCta)이 다시 붙어 이 버튼을 덮는다(BUG-21 처리와 맞물림).
            커서를 입력칸에 둔 채 누르게 한다 */}
        <Button
          type="submit"
          variant="secondary"
          size="l"
          loading={pending}
          disabled={!value.trim()}
          onMouseDown={(e) => e.preventDefault()}
          className="h-14 flex-none"
          data-testid="recipient-save"
        >
          저장
        </Button>
      </div>
      {failure === "retry" && <p className="text-body-s text-text-danger">저장하지 못했어요. 다시 눌러 주세요.</p>}
      {failure === "auth" && (
        <p className="text-body-s text-text-danger">
          로그인이 풀렸어요.{" "}
          <Link href={`/login?next=${encodeURIComponent(`/room/${roomId}`)}`} className="font-bold underline">
            다시 로그인
          </Link>
          한 뒤 적어 주세요.
        </p>
      )}
      {renaming && (
        <Button
          variant="ghost"
          size="m"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setRenaming(false);
            setFailure(null);
          }}
        >
          취소
        </Button>
      )}
    </form>
  );
}
