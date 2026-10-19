"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { BottomCta } from "@/components/ui/bottom-cta";
import { Button } from "@/components/ui/button";
import { AlertIcon, ChatBubbleIcon, EyeIcon, EyeOffIcon } from "@/components/ui/icons";
import { Banner } from "@/components/ui/banner";
import { textFieldClass } from "@/components/ui/text-field";
import { login, loginWithKakao, type LoginState } from "./actions";

const initialState: LoginState = { error: null };

// 회색 면 입력칸 — 누르면 흰 바탕 + 파란 테두리, 틀리면 빨간 테두리
const inputClass = textFieldClass();

const SUB_LINE = "사장님은 문자나 카톡으로 받으신 링크를 누르시면 돼요.";

function ErrorLine({ children }: { children: string }) {
  return (
    <p role="alert" className="flex items-start gap-2 rounded-2xl bg-danger-tint px-4 py-3 text-body-m text-text-danger">
      <AlertIcon className="mt-0.5 size-5 flex-none" />
      {children}
    </p>
  );
}

// 카카오 동의 화면으로 넘어가는 동안 다시 못 누르게
function KakaoButton() {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      variant="kakao"
      size="xl"
      block
      loading={pending}
      icon={<ChatBubbleIcon className="size-6" />}
      data-testid="kakao-login"
    >
      카카오로 시작하기
    </Button>
  );
}

// 로그인 (AUTH-02·AUTH-10). 기본은 카카오 하나. 처음이면 그대로 가입된다.
// 이메일·비밀번호 로그인은 아래 작은 '이메일로 로그인'으로 숨겨 둔다(관리자가 만든 계정, 앱 심사용 계정)
// deleted: 회원 탈퇴 뒤 돌아왔을 때 (AUTH-11)
export function LoginForm({ next, kakaoFailed, deleted }: { next: string; kakaoFailed: boolean; deleted: boolean }) {
  const [state, formAction, pending] = useActionState(login, initialState);
  const [mode, setMode] = useState<"kakao" | "email">("kakao");
  // 비밀번호를 잘못 치기 쉬워서 보이게 할 수 있다 (AUTH-02)
  const [showPassword, setShowPassword] = useState(false);
  const invalid = !!state.error || undefined;

  if (mode === "kakao") {
    return (
      <form action={loginWithKakao} className="flex w-full flex-1 flex-col" data-testid="login-kakao">
        <input type="hidden" name="next" value={next} />
        <h1 className="pt-8 text-title-l text-text-primary">
          카카오 계정으로
          <br />
          시작해 주세요
        </h1>
        <p className="pt-2 pb-8 text-body-l text-text-secondary">처음이시면 바로 가입돼요.</p>

        {deleted && (
          <Banner tone="success" flat role="status" testId="account-deleted" sub="계정과 상담 기록을 모두 지웠어요.">
            탈퇴했어요
          </Banner>
        )}
        {kakaoFailed && <ErrorLine>카카오 로그인을 마치지 못했어요. 다시 눌러 주세요.</ErrorLine>}

        <BottomCta>
          <KakaoButton />
          <button
            type="button"
            onClick={() => setMode("email")}
            className="min-h-touch text-label-m text-text-secondary"
            data-testid="email-login-open"
          >
            이메일로 로그인
          </button>
          <p className="text-center text-body-s text-text-secondary">{SUB_LINE}</p>
        </BottomCta>
      </form>
    );
  }

  return (
    <form action={formAction} className="flex w-full flex-1 flex-col gap-5" data-testid="login-email">
      <input type="hidden" name="next" value={next} />

      <h1 className="pt-8 pb-3 text-title-l text-text-primary">
        이메일로
        <br />
        로그인해 주세요
      </h1>

      <label className="flex flex-col gap-2">
        <span className="text-label-m text-text-secondary">이메일</span>
        <input
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          required
          placeholder="name@example.com"
          defaultValue={state.email}
          aria-invalid={invalid}
          className={inputClass}
        />
      </label>

      <label className="flex flex-col gap-2">
        <span className="text-label-m text-text-secondary">비밀번호</span>
        <span className="relative">
          <input
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            required
            aria-invalid={invalid}
            className={`${inputClass} pr-14`}
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            aria-label={showPassword ? "비밀번호 숨기기" : "비밀번호 보기"}
            aria-pressed={showPassword}
            className="absolute inset-y-0 right-1 my-auto grid size-12 place-items-center rounded-xl text-icon-secondary active:bg-border"
          >
            {showPassword ? <EyeOffIcon className="size-6" /> : <EyeIcon className="size-6" />}
          </button>
        </span>
      </label>

      {state.error && <ErrorLine>{state.error}</ErrorLine>}

      <BottomCta>
        <Button type="submit" size="xl" block loading={pending}>
          {pending ? "로그인 중…" : "로그인"}
        </Button>
        <button
          type="button"
          onClick={() => setMode("kakao")}
          className="min-h-touch text-label-m text-text-secondary"
        >
          카카오로 시작하기
        </button>
        <p className="text-center text-body-s text-text-secondary">
          이메일 계정은 관리자에게 받아 주세요.
          <br />
          {SUB_LINE}
        </p>
      </BottomCta>
    </form>
  );
}
