// features/snippets/SnippetVariableModal.test.tsx
// TDD RED phase — variable-fill modal with live preview.

import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SnippetVariableModal } from "./SnippetVariableModal";
import type { Token } from "./snippetParser";

// jsdom requires manual <dialog> stub
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});

// ── Mock i18n ──────────────────────────────────────────────────
const { mockT } = vi.hoisted(() => ({
  mockT: vi.fn((key: string) => key),
}));
vi.mock("../../lib/i18n", () => ({
  useI18n: () => ({ t: mockT }),
}));

// ── Renders inputs per variable ────────────────────────────────

describe("SnippetVariableModal — renders inputs", () => {
  it("renders an input for each user-defined variable", () => {
    const vars: Token[] = [
      { kind: "variable", name: "host", type: "text" },
      { kind: "variable", name: "user", type: "text" },
    ];
    render(
      <SnippetVariableModal
        open
        template="ssh {{host}} -l {{user}}"
        variables={vars}
        onInject={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    // Should have two inputs for host and user
    expect(screen.getByLabelText(/host/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/user/i)).toBeInTheDocument();
  });
});

// ── Password type renders <input type="password"> ─────────────

describe("SnippetVariableModal — password type", () => {
  it("renders type=password for password-type variables", () => {
    const vars: Token[] = [
      { kind: "variable", name: "token", type: "password" },
    ];
    render(
      <SnippetVariableModal
        open
        template="Bearer {{token:password}}"
        variables={vars}
        onInject={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByLabelText(/token/i);
    expect(input).toHaveAttribute("type", "password");
  });

  it("masks password value in live preview with ***", () => {
    const vars: Token[] = [
      { kind: "variable", name: "token", type: "password" },
    ];
    render(
      <SnippetVariableModal
        open
        template="Bearer {{token:password}}"
        variables={vars}
        onInject={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByLabelText(/token/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "secret123" } });
    // Preview should show *** not the actual value
    const preview = screen.getByTestId("snippet-preview");
    expect(preview.textContent).toContain("***");
    expect(preview.textContent).not.toContain("secret123");
  });
});

// ── Choice type renders <select> ──────────────────────────────

describe("SnippetVariableModal — choice type", () => {
  it("renders a select element for choice-type variables", () => {
    const vars: Token[] = [
      {
        kind: "variable",
        name: "env",
        type: "choice",
        choices: ["prod", "staging", "dev"],
        default: "prod",
      },
    ];
    render(
      <SnippetVariableModal
        open
        template="deploy {{env:choice:prod|staging|dev}}"
        variables={vars}
        onInject={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const select = screen.getByRole("combobox");
    expect(select).toBeInTheDocument();
    expect(screen.getByText("prod")).toBeInTheDocument();
    expect(screen.getByText("staging")).toBeInTheDocument();
    expect(screen.getByText("dev")).toBeInTheDocument();
  });
});

// ── Live preview updates on input change ─────────────────────

describe("SnippetVariableModal — live preview", () => {
  it("updates preview when user changes an input", () => {
    const vars: Token[] = [
      { kind: "variable", name: "host", type: "text" },
    ];
    render(
      <SnippetVariableModal
        open
        template="ssh {{host}}"
        variables={vars}
        onInject={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByLabelText(/host/i);
    fireEvent.change(input, { target: { value: "10.0.0.1" } });
    const preview = screen.getByTestId("snippet-preview");
    expect(preview.textContent).toContain("10.0.0.1");
  });
});

// ── MAJOR-1: zero-user-variable snippet — no inputs, preview shown ───────────
// Regression guard for CRITICAL-1 fix: when a snippet has no user-promptable
// vars (only dynamic built-ins already resolved), the modal must still open,
// show the resolved preview, and let the user choose Insert or Execute
// deliberately. No text inputs must appear.

describe("SnippetVariableModal — zero user variables", () => {
  it("renders no text inputs when variables array is empty", () => {
    render(
      <SnippetVariableModal
        open
        template="whoami"
        variables={[]}
        onInject={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    // No inputs should be rendered (only the Cancel/Insert/Execute buttons)
    const inputs = document.querySelectorAll("input, select");
    expect(inputs).toHaveLength(0);
  });

  it("shows the resolved command in the preview for a zero-variable snippet", () => {
    render(
      <SnippetVariableModal
        open
        template="uptime"
        variables={[]}
        onInject={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const preview = screen.getByTestId("snippet-preview");
    expect(preview.textContent).toBe("uptime");
  });

  it("clicking Execute on a zero-variable snippet calls onInject with mode='execute'", () => {
    const onInject = vi.fn();
    render(
      <SnippetVariableModal
        open
        template="uptime"
        variables={[]}
        onInject={onInject}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /snippets\.execute/i }));
    expect(onInject).toHaveBeenCalledWith(
      expect.objectContaining({ resolvedCommand: "uptime", mode: "execute" }),
    );
  });

  it("clicking Insert on a zero-variable snippet calls onInject with mode='insert'", () => {
    const onInject = vi.fn();
    render(
      <SnippetVariableModal
        open
        template="uptime"
        variables={[]}
        onInject={onInject}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /snippets\.insert/i }));
    expect(onInject).toHaveBeenCalledWith(
      expect.objectContaining({ resolvedCommand: "uptime", mode: "insert" }),
    );
  });
});

// ── MINOR-2: password values cleared on cancel/close ─────────────────────────
// Before fix: Cancel called onClose but did NOT clear password-type values
// from component state, leaving a typed secret in React state until next open.

describe("SnippetVariableModal — password cleared on cancel", () => {
  it("clears password-type values when the modal is closed (open goes false)", () => {
    const vars: Token[] = [
      { kind: "variable", name: "secret", type: "password" },
    ];
    const { rerender } = render(
      <SnippetVariableModal
        open
        template="token {{secret:password}}"
        variables={vars}
        onInject={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    // Type a secret
    const input = screen.getByLabelText(/secret/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "supersecret" } });
    expect(input.value).toBe("supersecret");

    // Close the modal by setting open=false
    rerender(
      <SnippetVariableModal
        open={false}
        template="token {{secret:password}}"
        variables={vars}
        onInject={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    // Re-open — the password field must be empty (state was cleared on close)
    rerender(
      <SnippetVariableModal
        open
        template="token {{secret:password}}"
        variables={vars}
        onInject={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const inputAgain = screen.getByLabelText(/secret/i) as HTMLInputElement;
    expect(inputAgain.value).toBe("");
  });
});

// ── Insert and Execute buttons ────────────────────────────────

describe("SnippetVariableModal — action buttons", () => {
  it("renders Insert button", () => {
    render(
      <SnippetVariableModal
        open
        template="ls"
        variables={[]}
        onInject={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /snippets\.insert/i })).toBeInTheDocument();
  });

  it("renders Execute button", () => {
    render(
      <SnippetVariableModal
        open
        template="ls"
        variables={[]}
        onInject={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /snippets\.execute/i })).toBeInTheDocument();
  });

  it("clicking Insert calls onInject with mode='insert'", () => {
    const onInject = vi.fn();
    const vars: Token[] = [
      { kind: "variable", name: "path", type: "text" },
    ];
    render(
      <SnippetVariableModal
        open
        template="ls {{path}}"
        variables={vars}
        onInject={onInject}
        onClose={vi.fn()}
      />,
    );
    // Fill in the variable
    const input = screen.getByLabelText(/path/i);
    fireEvent.change(input, { target: { value: "/tmp" } });
    // Click Insert
    fireEvent.click(screen.getByRole("button", { name: /snippets\.insert/i }));
    expect(onInject).toHaveBeenCalledWith(
      expect.objectContaining({ resolvedCommand: "ls /tmp", mode: "insert" }),
    );
  });

  it("clicking Execute calls onInject with mode='execute'", () => {
    const onInject = vi.fn();
    render(
      <SnippetVariableModal
        open
        template="whoami"
        variables={[]}
        onInject={onInject}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /snippets\.execute/i }));
    expect(onInject).toHaveBeenCalledWith(
      expect.objectContaining({ resolvedCommand: "whoami", mode: "execute" }),
    );
  });
});
