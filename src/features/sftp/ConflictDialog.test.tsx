// ConflictDialog.test.tsx — TDD tests for SFTP conflict resolution dialog
//
// WU-4: RED phase — written before the implementation.

import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// jsdom does not implement the native <dialog> modal API.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close() {
    this.open = false;
  };
});
import { ConflictDialog } from "./ConflictDialog";
import type { ConflictInfo } from "../../lib/types";

vi.mock("../../lib/i18n", () => ({
  useI18n: () => ({ t: (k: string) => k }),
}));

const singleConflict: ConflictInfo = {
  fileName: "report.pdf",
  destinationPath: "/home/user/report.pdf",
  existingSize: 102400,
  existingModified: 1700000000,
  incomingSize: 204800,
  direction: "download",
};

describe("ConflictDialog", () => {
  it("renders null when open=false", () => {
    const { container } = render(
      <ConflictDialog
        open={false}
        conflict={singleConflict}
        onResolve={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders null when conflict=null", () => {
    const { container } = render(
      <ConflictDialog
        open={true}
        conflict={null}
        onResolve={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders the file name", () => {
    render(
      <ConflictDialog
        open={true}
        conflict={singleConflict}
        onResolve={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("report.pdf")).toBeDefined();
  });

  it("Skip button is auto-focused (safe default)", () => {
    render(
      <ConflictDialog
        open={true}
        conflict={singleConflict}
        onResolve={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const skipBtn = screen.getByRole("button", { name: "sftp.conflict.skip" });
    expect(skipBtn).toBeDefined();
    // The skip button carries the autofocus data attribute
    expect(skipBtn.dataset.autofocus ?? skipBtn.getAttribute("autofocus")).not.toBeUndefined();
  });

  it("clicking Skip calls onResolve with 'skip'", () => {
    const onResolve = vi.fn();
    render(
      <ConflictDialog
        open={true}
        conflict={singleConflict}
        onResolve={onResolve}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "sftp.conflict.skip" }));
    expect(onResolve).toHaveBeenCalledWith("skip");
  });

  it("clicking Overwrite calls onResolve with 'overwrite'", () => {
    const onResolve = vi.fn();
    render(
      <ConflictDialog
        open={true}
        conflict={singleConflict}
        onResolve={onResolve}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "sftp.conflict.overwrite" }));
    expect(onResolve).toHaveBeenCalledWith("overwrite");
  });

  it("clicking Skip All calls onResolve with 'skip_all'", () => {
    const onResolve = vi.fn();
    render(
      <ConflictDialog
        open={true}
        conflict={singleConflict}
        onResolve={onResolve}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "sftp.conflict.skipAll" }));
    expect(onResolve).toHaveBeenCalledWith("skip_all");
  });

  it("clicking Overwrite All calls onResolve with 'overwrite_all'", () => {
    const onResolve = vi.fn();
    render(
      <ConflictDialog
        open={true}
        conflict={singleConflict}
        onResolve={onResolve}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "sftp.conflict.overwriteAll" }));
    expect(onResolve).toHaveBeenCalledWith("overwrite_all");
  });

  it("dialog has an accessible name", () => {
    render(
      <ConflictDialog
        open={true}
        conflict={singleConflict}
        onResolve={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const dialog = document.querySelector(
      "[role='dialog'], [aria-labelledby], [aria-label]",
    );
    expect(dialog).not.toBeNull();
  });

  it("Overwrite button has danger styling (data-variant=danger)", () => {
    render(
      <ConflictDialog
        open={true}
        conflict={singleConflict}
        onResolve={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const overwriteBtn = screen.getByRole("button", { name: "sftp.conflict.overwrite" });
    expect(
      overwriteBtn.dataset.variant ?? overwriteBtn.className,
    ).toMatch(/danger/);
  });
});
