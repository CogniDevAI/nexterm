// features/docker/RmConfirmDialog.test.tsx — TDD: two-step rm confirm dialog

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// ── i18n mock ─────────────────────────────────────────────────────────────────

vi.mock("../../lib/i18n", () => ({
  useI18n: () => ({
    t: (k: string) => {
      const labels: Record<string, string> = {
        "docker.rm.arm": "Remove",
        "docker.rm.confirm": "Confirm Remove",
        "docker.rm.cancel": "Cancel",
        "docker.rm.container": "Container",
      };
      return labels[k] ?? k;
    },
  }),
}));

import { RmConfirmDialog } from "./RmConfirmDialog";

describe("RmConfirmDialog", () => {
  const onRm = vi.fn();
  const onCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function renderDialog(containerId = "abc123", containerName = "myapp") {
    return render(
      <RmConfirmDialog
        containerId={containerId}
        containerName={containerName}
        onRm={onRm}
        onCancel={onCancel}
      />,
    );
  }

  it("renders the initial arm button", () => {
    renderDialog();
    expect(screen.getByRole("button", { name: /Remove/i })).toBeInTheDocument();
  });

  it("shows container name in accessible text", () => {
    renderDialog("abc123", "myapp");
    expect(screen.getByText(/myapp/)).toBeInTheDocument();
  });

  it("first click arms the dialog (shows confirm button)", () => {
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: /^Remove$/i }));
    expect(
      screen.getByRole("button", { name: /Confirm Remove/i }),
    ).toBeInTheDocument();
  });

  it("second click (confirm) calls onRm with the containerId", () => {
    renderDialog("abc123", "myapp");
    // Arm
    fireEvent.click(screen.getByRole("button", { name: /^Remove$/i }));
    // Confirm
    fireEvent.click(screen.getByRole("button", { name: /Confirm Remove/i }));
    expect(onRm).toHaveBeenCalledWith("abc123");
  });

  it("cancel resets to unarmed state without calling onRm", () => {
    renderDialog();
    // Arm
    fireEvent.click(screen.getByRole("button", { name: /^Remove$/i }));
    // Cancel
    fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));
    expect(onRm).not.toHaveBeenCalled();
    // Should be back to the arm button
    expect(screen.getByRole("button", { name: /^Remove$/i })).toBeInTheDocument();
  });

  it("does not call onRm after first click alone", () => {
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: /^Remove$/i }));
    expect(onRm).not.toHaveBeenCalled();
  });
});
