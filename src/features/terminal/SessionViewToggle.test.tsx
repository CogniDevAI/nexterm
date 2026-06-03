// SessionViewToggle.test.tsx — the persistent Terminal | Files switch
//
// The toggle MUST be visible (and functional) in BOTH views — that is the whole
// point of extracting it out of the display:none'd terminal area.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// ── i18n mock ─────────────────────────────────────────────────────────────────
vi.mock("../../lib/i18n", () => ({
  useI18n: () => ({
    t: (k: string) => {
      const labels: Record<string, string> = {
        "view.terminal": "Terminal",
        "view.files": "Files",
      };
      return labels[k] ?? k;
    },
  }),
}));

// ── workspaceStore mock ───────────────────────────────────────────────────────
const mockSetMainView = vi.fn();

vi.mock("../../stores/workspaceStore", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useWorkspaceStore: vi.fn((selector?: (s: any) => any) => {
    const state = { setMainView: mockSetMainView };
    return typeof selector === "function" ? selector(state) : state;
  }),
}));

import { SessionViewToggle } from "./SessionViewToggle";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SessionViewToggle", () => {
  it("renders both Terminal and Files buttons in terminal view", () => {
    render(<SessionViewToggle workspaceKey="profile-1:user-1" mainView="terminal" />);
    expect(screen.getByRole("button", { name: "Terminal" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Files" })).toBeInTheDocument();
  });

  it("renders both Terminal and Files buttons in files view (toggle stays visible)", () => {
    render(<SessionViewToggle workspaceKey="profile-1:user-1" mainView="files" />);
    expect(screen.getByRole("button", { name: "Terminal" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Files" })).toBeInTheDocument();
  });

  it("marks Terminal button aria-pressed=true when mainView is terminal", () => {
    render(<SessionViewToggle workspaceKey="profile-1:user-1" mainView="terminal" />);
    expect(screen.getByRole("button", { name: "Terminal" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Files" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("marks Files button aria-pressed=true when mainView is files", () => {
    render(<SessionViewToggle workspaceKey="profile-1:user-1" mainView="files" />);
    expect(screen.getByRole("button", { name: "Files" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Terminal" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("clicking Files calls setMainView(key, 'files')", () => {
    render(<SessionViewToggle workspaceKey="profile-1:user-1" mainView="terminal" />);
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    expect(mockSetMainView).toHaveBeenCalledWith("profile-1:user-1", "files");
  });

  it("clicking Terminal FROM files view calls setMainView(key, 'terminal') — the fix", () => {
    render(<SessionViewToggle workspaceKey="profile-1:user-1" mainView="files" />);
    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    expect(mockSetMainView).toHaveBeenCalledWith("profile-1:user-1", "terminal");
  });
});
