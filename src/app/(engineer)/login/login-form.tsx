"use client";

import { useActionState, useState } from "react";
import { BottomCta } from "@/components/ui/bottom-cta";
import { Button } from "@/components/ui/button";
import { AlertIcon, EyeIcon, EyeOffIcon } from "@/components/ui/icons";
import { login, type LoginState } from "./actions";

const initialState: LoginState = { error: null };

// 회색 면 입력칸 — 누르면 흰 바탕 + 파란 테두리, 틀리면 빨간 테두리
const inputClass =
  "h-14 w-full rounded-2xl border-2 border-transparent bg-bg-subtle px-4 text-body-l text-text-primary outline-none transition-colors placeholder:text-text-tertiary focus:border-border-focus focus:bg-bg-page aria-invalid:border-danger";

export function LoginForm({ next }: { next: string }) {
  const [state, formAction, pending] = useActionState(login, initialState);
  // 비밀번호를 잘못 치기 쉬워서 보이게 할 수 있다 (AUTH-02)
  const [showPassword, setShowPassword] = useState(false);
  const invalid = !!state.error || undefined;

  return (
    <form action={formAction} className="flex w-full flex-1 flex-col gap-5">
      <input type="hidden" name="next" value={next} />

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

      {state.error && (
        <p role="alert" className="flex items-start gap-2 rounded-2xl bg-danger-tint px-4 py-3 text-body-m text-text-danger">
          <AlertIcon className="mt-0.5 size-5 flex-none" />
          {state.error}
        </p>
      )}

      <BottomCta>
        <Button type="submit" size="xl" block loading={pending}>
          {pending ? "로그인 중…" : "로그인"}
        </Button>
        <p className="pt-1 text-center text-body-s text-text-secondary">
          계정은 관리자에게 받아 주세요.
          <br />
          사장님은 문자 속 링크를 누르시면 돼요.
        </p>
      </BottomCta>
    </form>
  );
}
