// MfaChallengeDialog.test.tsx — TDD tests for keyboard-interactive challenge UI

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MfaChallengeDialog } from "./MfaChallengeDialog";
import type { KeyboardInteractiveChallengeRequest } from "../../lib/types";

vi.mock("../../lib/i18n", () => ({
  useI18n: () => ({ t: (k: string) => k }),
}));

const echoPrompt: KeyboardInteractiveChallengeRequest = {
  sessionId: "s1",
  name: "MFA",
  instruction: "Enter your code",
  prompts: [
    { text: "Code:", echo: false },
    { text: "Backup:", echo: true },
  ],
  round: 1,
};

const singlePrompt: KeyboardInteractiveChallengeRequest = {
  sessionId: "s1",
  name: "SSH",
  instruction: "",
  prompts: [{ text: "Password:", echo: false }],
  round: 1,
};

const noPrompts: KeyboardInteractiveChallengeRequest = {
  sessionId: "s1",
  name: "Two-factor",
  instruction: "",
  prompts: [],
  round: 1,
};

describe("MfaChallengeDialog", () => {
  it("renders null when open=false", () => {
    const { container } = render(
      <MfaChallengeDialog
        open={false}
        challenge={singlePrompt}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders null when challenge=null", () => {
    const { container } = render(
      <MfaChallengeDialog
        open={true}
        challenge={null}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders one input per prompt", () => {
    render(
      <MfaChallengeDialog
        open={true}
        challenge={echoPrompt}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const inputs = screen.getAllByRole("textbox").concat(
      // password inputs are not role=textbox
      Array.from(document.querySelectorAll('input[type="password"]')),
    );
    expect(inputs).toHaveLength(2);
  });

  it("echo=false → input type password", () => {
    render(
      <MfaChallengeDialog
        open={true}
        challenge={singlePrompt}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const input = document.querySelector('input[type="password"]');
    expect(input).not.toBeNull();
  });

  it("echo=true → input type text", () => {
    render(
      <MfaChallengeDialog
        open={true}
        challenge={echoPrompt}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const textInputs = screen.getAllByRole("textbox");
    expect(textInputs.length).toBeGreaterThanOrEqual(1);
  });

  it("submit calls onSubmit with answers in prompt order", () => {
    const onSubmit = vi.fn();
    render(
      <MfaChallengeDialog
        open={true}
        challenge={echoPrompt}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    const pwInput = document.querySelector('input[type="password"]') as HTMLInputElement;
    const textInput = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(pwInput, { target: { value: "secret" } });
    fireEvent.change(textInput, { target: { value: "backup123" } });
    fireEvent.click(screen.getByRole("button", { name: "mfa.submit" }));
    expect(onSubmit).toHaveBeenCalledWith(["secret", "backup123"]);
  });

  it("cancel calls onCancel", () => {
    const onCancel = vi.fn();
    render(
      <MfaChallengeDialog
        open={true}
        challenge={singlePrompt}
        onSubmit={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "mfa.cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("dialog has an accessible name", () => {
    render(
      <MfaChallengeDialog
        open={true}
        challenge={singlePrompt}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    // The dialog element should be labelled (aria-labelledby or aria-label)
    const dialog = document.querySelector("[role='dialog'], [aria-labelledby], [aria-label]");
    expect(dialog).not.toBeNull();
  });

  it("prompts.length 0 — submit sends empty array", () => {
    const onSubmit = vi.fn();
    render(
      <MfaChallengeDialog
        open={true}
        challenge={noPrompts}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "mfa.submit" }));
    expect(onSubmit).toHaveBeenCalledWith([]);
  });
});
