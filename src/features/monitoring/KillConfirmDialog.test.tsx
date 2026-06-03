// features/monitoring/KillConfirmDialog.test.tsx — TDD: two-step kill confirm

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// ── i18n mock ─────────────────────────────────────────────────────────────────
vi.mock("../../lib/i18n", () => ({
  useI18n: () => ({
    t: (k: string) => {
      const labels: Record<string, string> = {
        "monitoring.kill.arm": "Kill",
        "monitoring.kill.confirm": "Confirm Kill",
        "monitoring.kill.cancel": "Cancel",
        "monitoring.kill.pid": "PID",
      };
      return labels[k] ?? k;
    },
  }),
}));

import { KillConfirmDialog } from "./KillConfirmDialog";

describe("KillConfirmDialog", () => {
  const onKill = vi.fn();
  const onCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function renderDialog(pid = 42) {
    return render(
      <KillConfirmDialog pid={pid} onKill={onKill} onCancel={onCancel} />,
    );
  }

  it("renders the initial arm button", () => {
    renderDialog();
    expect(screen.getByRole("button", { name: /Kill/i })).toBeInTheDocument();
  });

  it("shows PID in accessible text", () => {
    renderDialog(1337);
    // The dialog should expose the PID somewhere in the rendered output
    expect(screen.getByText(/1337/)).toBeInTheDocument();
  });

  it("first click arms the dialog (shows confirm button)", () => {
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: /^Kill$/i }));
    expect(screen.getByRole("button", { name: /Confirm Kill/i })).toBeInTheDocument();
  });

  it("second click (confirm) calls onKill with the pid", () => {
    renderDialog(42);
    // Arm
    fireEvent.click(screen.getByRole("button", { name: /^Kill$/i }));
    // Confirm
    fireEvent.click(screen.getByRole("button", { name: /Confirm Kill/i }));
    expect(onKill).toHaveBeenCalledWith(42);
  });

  it("cancel resets to unarmed state without calling onKill", () => {
    renderDialog();
    // Arm
    fireEvent.click(screen.getByRole("button", { name: /^Kill$/i }));
    // Cancel
    fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));
    expect(onKill).not.toHaveBeenCalled();
    // Should be back to the arm button
    expect(screen.getByRole("button", { name: /^Kill$/i })).toBeInTheDocument();
  });

  it("does not call onKill after first click alone", () => {
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: /^Kill$/i }));
    expect(onKill).not.toHaveBeenCalled();
  });
});
