// features/proxmox/SnapshotConfirmDialog.test.tsx — TDD: two-step snapshot confirm

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// ── i18n mock ─────────────────────────────────────────────────────────────────

vi.mock("../../lib/i18n", () => ({
  useI18n: () => ({
    t: (k: string) => {
      const labels: Record<string, string> = {
        "proxmox.snapshot.rollback.arm": "Rollback",
        "proxmox.snapshot.rollback.confirm": "Confirm Rollback",
        "proxmox.snapshot.rollback.cancel": "Cancel",
        "proxmox.snapshot.rollback.warning":
          "Warning: rollback discards current container state",
        "proxmox.snapshot.delete.arm": "Delete",
        "proxmox.snapshot.delete.confirm": "Confirm Delete",
        "proxmox.snapshot.delete.cancel": "Cancel",
      };
      return labels[k] ?? k;
    },
  }),
}));

import { SnapshotConfirmDialog } from "./SnapshotConfirmDialog";

describe("SnapshotConfirmDialog — rollback action", () => {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function renderRollback(snapshotName = "snap1") {
    return render(
      <SnapshotConfirmDialog
        action="rollback"
        snapshotName={snapshotName}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
  }

  it("renders the initial arm button for rollback", () => {
    renderRollback();
    expect(
      screen.getByRole("button", { name: /^Rollback$/i }),
    ).toBeInTheDocument();
  });

  it("shows snapshot name in accessible label", () => {
    renderRollback("snap1");
    expect(screen.getByText(/snap1/)).toBeInTheDocument();
  });

  it("first click arms the dialog (shows confirm button)", () => {
    renderRollback();
    fireEvent.click(screen.getByRole("button", { name: /^Rollback$/i }));
    expect(
      screen.getByRole("button", { name: /Confirm Rollback/i }),
    ).toBeInTheDocument();
  });

  it("second click (confirm) calls onConfirm with snapshotName", () => {
    renderRollback("snap1");
    fireEvent.click(screen.getByRole("button", { name: /^Rollback$/i }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm Rollback/i }));
    expect(onConfirm).toHaveBeenCalledWith("snap1");
  });

  it("cancel resets to unarmed state without calling onConfirm", () => {
    renderRollback();
    fireEvent.click(screen.getByRole("button", { name: /^Rollback$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /^Rollback$/i }),
    ).toBeInTheDocument();
  });

  it("does not call onConfirm after arm-only click", () => {
    renderRollback();
    fireEvent.click(screen.getByRole("button", { name: /^Rollback$/i }));
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe("SnapshotConfirmDialog — delete action", () => {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function renderDelete(snapshotName = "snap1") {
    return render(
      <SnapshotConfirmDialog
        action="delete"
        snapshotName={snapshotName}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
  }

  it("renders the initial arm button for delete", () => {
    renderDelete();
    expect(
      screen.getByRole("button", { name: /^Delete$/i }),
    ).toBeInTheDocument();
  });

  it("second click (confirm) calls onConfirm with snapshotName for delete", () => {
    renderDelete("snap2");
    fireEvent.click(screen.getByRole("button", { name: /^Delete$/i }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm Delete/i }));
    expect(onConfirm).toHaveBeenCalledWith("snap2");
  });
});
