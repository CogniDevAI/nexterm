// a11y invariant: the feature switcher is a WAI-ARIA tablist — role="tablist"
// wraps role="tab" buttons with aria-selected reflecting the active feature,
// roving tabindex (active=0/others=-1), and Arrow/Home/End keyboard navigation.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useSessionStore } from "../../stores/sessionStore";
import type { SessionEntry } from "../../stores/sessionStore";

// This jsdom config has a non-functional localStorage; the workspace store
// persist middleware resolves its storage at import time, so the in-memory stub
// MUST be installed before any store module loads. vi.hoisted runs first.
vi.hoisted(() => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => void store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
});

// ─── Mocks ───────────────────────────────────────────────────────────────────

// Mock i18n — return the real English labels so accessible names match usage.
const LABELS: Record<string, string> = {
  "tabbar.terminal": "Terminal",
  "tabbar.sftp": "SFTP",
  "tabbar.tunnels": "Tunnels",
};
vi.mock("../../lib/i18n", () => ({
  useI18n: () => ({ t: (k: string) => LABELS[k] ?? k }),
}));

// ─── Import after mocks ───────────────────────────────────────────────────────
import { TabBar } from "./TabBar";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSession(id: string): SessionEntry {
  return {
    id,
    profileId: "profile-1",
    profileName: "Test Server",
    host: "192.168.1.1",
    userId: "user-1",
    username: "admin",
    port: 22,
    connectedAt: Date.now(),
    state: "connected",
    terminals: [],
    activeTerminalId: null,
  };
}

function resetStore() {
  useSessionStore.setState({
    sessions: new Map(),
    activeSessionId: null,
    activeFeature: "terminal",
  });
}

function setupActiveSession(
  id = "sid-1",
  activeFeature: "terminal" | "sftp" | "tunnel" = "terminal",
) {
  useSessionStore.setState({
    sessions: new Map([[id, makeSession(id)]]),
    activeSessionId: id,
    activeFeature,
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("TabBar — WAI-ARIA tabs", () => {
  beforeEach(() => {
    resetStore();
    setupActiveSession();
  });

  afterEach(() => {
    resetStore();
  });

  it("renders a tablist containing the feature tabs", () => {
    render(<TabBar />);
    const tablist = screen.getByRole("tablist");
    expect(tablist).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Terminal" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "SFTP" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Tunnels" })).toBeInTheDocument();
  });

  it("marks the active feature with aria-selected=true and others false", () => {
    render(<TabBar />);
    expect(screen.getByRole("tab", { name: "Terminal" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "SFTP" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    expect(screen.getByRole("tab", { name: "Tunnels" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("applies roving tabindex (active=0, others=-1)", () => {
    render(<TabBar />);
    expect(screen.getByRole("tab", { name: "Terminal" })).toHaveAttribute(
      "tabindex",
      "0",
    );
    expect(screen.getByRole("tab", { name: "SFTP" })).toHaveAttribute(
      "tabindex",
      "-1",
    );
    expect(screen.getByRole("tab", { name: "Tunnels" })).toHaveAttribute(
      "tabindex",
      "-1",
    );
  });

  it("click selects a tab (existing behavior preserved)", () => {
    render(<TabBar />);
    fireEvent.click(screen.getByRole("tab", { name: "SFTP" }));
    expect(screen.getByRole("tab", { name: "SFTP" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("ArrowRight moves selection to the next tab", () => {
    render(<TabBar />);
    const terminal = screen.getByRole("tab", { name: "Terminal" });
    fireEvent.keyDown(terminal, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "SFTP" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("ArrowLeft moves selection to the previous tab", () => {
    setupActiveSession("sid-1", "sftp");
    render(<TabBar />);
    const sftp = screen.getByRole("tab", { name: "SFTP" });
    fireEvent.keyDown(sftp, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "Terminal" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("ArrowRight does not wrap past the last tab", () => {
    setupActiveSession("sid-1", "tunnel");
    render(<TabBar />);
    const tunnels = screen.getByRole("tab", { name: "Tunnels" });
    fireEvent.keyDown(tunnels, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Tunnels" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("Home selects the first tab, End selects the last", () => {
    setupActiveSession("sid-1", "sftp");
    render(<TabBar />);
    fireEvent.keyDown(screen.getByRole("tab", { name: "SFTP" }), {
      key: "End",
    });
    expect(screen.getByRole("tab", { name: "Tunnels" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.keyDown(screen.getByRole("tab", { name: "Tunnels" }), {
      key: "Home",
    });
    expect(screen.getByRole("tab", { name: "Terminal" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});
