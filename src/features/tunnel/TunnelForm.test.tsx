// features/tunnel/TunnelForm.test.tsx — TDD tests for dynamic tunnel type UI
//
// Scope: -D segmented tab, target section hidden when dynamic, SSH preview.
// i18n is mocked to return the key string — tests are locale-independent.

import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TunnelForm } from "./TunnelForm";

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock("../../lib/i18n", () => ({
  useI18n: () => ({ t: (k: string) => k }),
}));

// Dialog: render children directly (jsdom has no showModal)
vi.mock("../../components/ui/Dialog", () => ({
  Dialog: ({
    open,
    children,
  }: {
    open: boolean;
    children: React.ReactNode;
    onClose: () => void;
    title: string;
    width?: string;
  }) => (open ? <div data-testid="dialog">{children}</div> : null),
}));

// Input: pass-through with label + input
vi.mock("../../components/ui/Input", () => ({
  Input: ({
    id,
    label,
    value,
    onChange,
    type,
    placeholder,
    className,
    error,
  }: {
    id: string;
    label: string;
    value: string;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    type?: string;
    placeholder?: string;
    className?: string;
    error?: string;
  }) => (
    <div>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        value={value}
        onChange={onChange}
        type={type ?? "text"}
        placeholder={placeholder}
        className={className}
        data-error={error ?? ""}
      />
    </div>
  ),
}));

vi.mock("../../components/ui/Button", () => ({
  Button: ({
    children,
    onClick,
    variant,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    variant?: string;
  }) => (
    <button onClick={onClick} data-variant={variant ?? ""}>
      {children}
    </button>
  ),
}));

// ─── Setup ───────────────────────────────────────────────────────────────────

const NOOP = () => {};
const NOOP_SUBMIT = vi.fn();

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("TunnelForm — -D dynamic tunnel tab", () => {
  it("renders a -D button in the segmented control", () => {
    render(<TunnelForm open onClose={NOOP} onSubmit={NOOP_SUBMIT} />);
    const dButton = screen.getByRole("button", { name: /-D/i });
    expect(dButton).toBeInTheDocument();
  });

  it("clicking -D activates the dynamic tab", () => {
    render(<TunnelForm open onClose={NOOP} onSubmit={NOOP_SUBMIT} />);
    const dButton = screen.getByRole("button", { name: /-D/i });
    fireEvent.click(dButton);
    expect(dButton.className).toContain("cd-segmented-btn-active");
  });

  it("target host input is hidden when -D is selected", () => {
    render(<TunnelForm open onClose={NOOP} onSubmit={NOOP_SUBMIT} />);
    const dButton = screen.getByRole("button", { name: /-D/i });
    fireEvent.click(dButton);
    // target host input must not be present
    const targetHostInput = screen.queryByLabelText("tunnelForm.host", {
      selector: "#tunnel-target-host",
    });
    expect(targetHostInput).toBeNull();
  });

  it("target port input is hidden when -D is selected", () => {
    render(<TunnelForm open onClose={NOOP} onSubmit={NOOP_SUBMIT} />);
    const dButton = screen.getByRole("button", { name: /-D/i });
    fireEvent.click(dButton);
    // Target port input must be absent from the DOM by ID
    const targetPortById = document.querySelector("#tunnel-target-port");
    expect(targetPortById).toBeNull();
  });

  it("SSH preview shows ssh -D format when dynamic is selected", () => {
    render(<TunnelForm open onClose={NOOP} onSubmit={NOOP_SUBMIT} />);
    const dButton = screen.getByRole("button", { name: /-D/i });
    fireEvent.click(dButton);
    const preview = screen.getByRole("code");
    expect(preview.textContent).toMatch(/-D/);
    // Should NOT contain the target:port part
    expect(preview.textContent).not.toMatch(/\?:\?$/);
  });

  it("sets bindHost to 127.0.0.1 when -D is selected", () => {
    render(<TunnelForm open onClose={NOOP} onSubmit={NOOP_SUBMIT} />);
    const dButton = screen.getByRole("button", { name: /-D/i });
    fireEvent.click(dButton);
    const bindHostInput = document.querySelector<HTMLInputElement>("#tunnel-bind-host");
    expect(bindHostInput?.value).toBe("127.0.0.1");
  });
});

describe("TunnelForm — -L and -R tabs regression", () => {
  it("renders -L and -R buttons", () => {
    render(<TunnelForm open onClose={NOOP} onSubmit={NOOP_SUBMIT} />);
    expect(screen.getByRole("button", { name: /-L/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /-R/i })).toBeInTheDocument();
  });

  it("target host input is visible for local type", () => {
    render(<TunnelForm open onClose={NOOP} onSubmit={NOOP_SUBMIT} />);
    // default is local
    const targetHostInput = document.querySelector("#tunnel-target-host");
    expect(targetHostInput).toBeInTheDocument();
  });

  it("shows -L as active by default", () => {
    render(<TunnelForm open onClose={NOOP} onSubmit={NOOP_SUBMIT} />);
    const lButton = screen.getByRole("button", { name: /-L/i });
    expect(lButton.className).toContain("cd-segmented-btn-active");
  });
});
