// SidePanel.test.tsx — a11y + interaction unit tests (Strict TDD RED first)

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// ── localStorage stub ─────────────────────────────────────────────────────────
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

// ── i18n mock ─────────────────────────────────────────────────────────────────
vi.mock("../../lib/i18n", () => ({
  useI18n: () => ({
    t: (k: string) => {
      const labels: Record<string, string> = {
        "panel.sftp": "Files",
        "panel.tunnels": "Tunnels",
        "panel.history": "History",
        "panel.close": "Close panel",
        "panel.region": "Session panel",
        "panel.sections": "Panel sections",
      };
      return labels[k] ?? k;
    },
  }),
}));

// ── workspaceStore mock ───────────────────────────────────────────────────────
// SidePanel uses useWorkspaceStore with selectors (e.g. useWorkspaceStore(s => s.panelOpen)).
// The mock must apply the selector when one is provided.
const mockSetPanelSection = vi.fn();
const mockSetPanelOpen = vi.fn();
const mockSetPanelWidth = vi.fn();
const mockSetMainView = vi.fn();

let _workspaceStoreState: ReturnType<typeof makeStoreState>;

vi.mock("../../stores/workspaceStore", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useWorkspaceStore: vi.fn((selector?: (s: any) => any) => {
    if (typeof selector === "function") {
      return selector(_workspaceStoreState);
    }
    return _workspaceStoreState;
  }),
  buildWorkspaceKey: vi.fn((p: string, u: string) => `${p}:${u}`),
  PANEL_WIDTH_DEFAULT: 420,
  PANEL_WIDTH_MIN: 320,
  PANEL_WIDTH_MAX: 820,
}));

// ── sessionStore mock ─────────────────────────────────────────────────────────
vi.mock("../../stores/sessionStore", () => ({
  useSessionStore: vi.fn(),
}));

// ── Child component mocks (not under test here) ────────────────────────────────
vi.mock("../../features/sftp/SftpBrowser", () => ({
  SftpBrowser: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="sftp-browser" data-session-id={sessionId} />
  ),
}));

vi.mock("../../features/tunnel/TunnelManager", () => ({
  TunnelManager: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="tunnel-manager" data-session-id={sessionId} />
  ),
}));

vi.mock("../../features/history/HistoryPanel", () => ({
  HistoryPanel: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="history-panel" data-session-id={sessionId} />
  ),
}));

import { SidePanel } from "./SidePanel";
import { useSessionStore } from "../../stores/sessionStore";

const mockedUseSessionStore = vi.mocked(useSessionStore);

function makeStoreState(
  panelOpen = false,
  panelSection: "sftp" | "tunnel" | "history" | null = null,
) {
  return {
    workspaces: {
      "profile-1:user-1": {
        key: "profile-1:user-1",
        profileId: "profile-1",
        userId: "user-1",
        activeTerminalId: null,
        sftp: {
          local: { path: "", history: [], historyIndex: -1 },
          remote: { path: "", history: [], historyIndex: -1 },
          splitPosition: 50,
          searchMode: "filter" as const,
          searchQuery: "",
        },
        panelSection,
        panelOpen,
        panelWidth: 420,
        mainView: "terminal" as const,
        updatedAt: Date.now(),
      },
    },
    setPanelSection: mockSetPanelSection,
    setPanelOpen: mockSetPanelOpen,
    setPanelWidth: mockSetPanelWidth,
    setMainView: mockSetMainView,
    getOrCreateWorkspace: vi.fn(),
    setActiveTerminalId: vi.fn(),
    setSftpSnapshot: vi.fn(),
  };
}

function makeSessionState(
  sessionId = "sid-1",
  profileId = "profile-1",
  userId = "user-1",
) {
  return {
    sessions: new Map([
      [
        sessionId,
        {
          id: sessionId,
          profileId,
          profileName: "Test",
          host: "1.2.3.4",
          userId,
          username: "admin",
          port: 22,
          connectedAt: Date.now(),
          state: "connected" as const,
          terminals: [],
          activeTerminalId: null,
        },
      ],
    ]),
    activeSessionId: sessionId,
    startupPreview: null,
    addSession: vi.fn(),
    removeSession: vi.fn(),
    setActiveSession: vi.fn(),
    updateSessionState: vi.fn(),
    setStartupPreview: vi.fn(),
    clearStartupPreview: vi.fn(),
    addTerminalTab: vi.fn(),
    removeTerminalTab: vi.fn(),
    replaceTerminalTab: vi.fn(),
    setActiveTerminal: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  _workspaceStoreState = makeStoreState();
  mockedUseSessionStore.mockReturnValue(makeSessionState() as ReturnType<typeof useSessionStore>);
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("SidePanel — icon rail a11y", () => {
  it("renders a toolbar with a distinct aria-label (panel.sections, not panel.region)", () => {
    render(<SidePanel />);
    expect(
      screen.getByRole("toolbar", { name: "Panel sections" }),
    ).toBeInTheDocument();
  });

  it("renders SFTP toggle button with accessible name", () => {
    render(<SidePanel />);
    expect(screen.getByRole("button", { name: "Files" })).toBeInTheDocument();
  });

  it("renders Tunnels toggle button with accessible name", () => {
    render(<SidePanel />);
    expect(
      screen.getByRole("button", { name: "Tunnels" }),
    ).toBeInTheDocument();
  });

  it("SFTP button has aria-pressed=false when panel is closed", () => {
    render(<SidePanel />);
    expect(screen.getByRole("button", { name: "Files" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("SFTP button always has aria-pressed=false (it navigates, never toggles)", () => {
    _workspaceStoreState = makeStoreState(true, "sftp");
    render(<SidePanel />);
    expect(screen.getByRole("button", { name: "Files" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("Tunnels button has aria-pressed=true when panel is open on tunnel", () => {
    _workspaceStoreState = makeStoreState(true, "tunnel");
    render(<SidePanel />);
    expect(screen.getByRole("button", { name: "Tunnels" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

describe("SidePanel — panel toggle interactions", () => {
  it("clicking SFTP button calls setMainView(key, 'files')", () => {
    render(<SidePanel />);
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    expect(mockSetMainView).toHaveBeenCalledWith(
      "profile-1:user-1",
      "files",
    );
    // Panel section/open are NOT called for the files button
    expect(mockSetPanelSection).not.toHaveBeenCalled();
    expect(mockSetPanelOpen).not.toHaveBeenCalled();
  });

  it("clicking an already-active Tunnels button closes the panel", () => {
    _workspaceStoreState = makeStoreState(true, "tunnel");
    render(<SidePanel />);
    fireEvent.click(screen.getByRole("button", { name: "Tunnels" }));
    expect(mockSetPanelOpen).toHaveBeenCalledWith("profile-1:user-1", false);
  });

  it("clicking Tunnels button when SFTP is active switches section", () => {
    _workspaceStoreState = makeStoreState(true, "sftp");
    render(<SidePanel />);
    fireEvent.click(screen.getByRole("button", { name: "Tunnels" }));
    expect(mockSetPanelSection).toHaveBeenCalledWith(
      "profile-1:user-1",
      "tunnel",
    );
    expect(mockSetPanelOpen).toHaveBeenCalledWith("profile-1:user-1", true);
  });
});

describe("SidePanel — content rendering", () => {
  it("does NOT render SftpBrowser (it has moved to main area)", () => {
    _workspaceStoreState = makeStoreState(true, "sftp");
    render(<SidePanel />);
    expect(screen.queryByTestId("sftp-browser")).not.toBeInTheDocument();
  });

  it("renders TunnelManager when panel is open on tunnel", () => {
    _workspaceStoreState = makeStoreState(true, "tunnel");
    render(<SidePanel />);
    expect(screen.getByTestId("tunnel-manager")).toBeInTheDocument();
  });

  it("does NOT render SftpBrowser when panel section is tunnel", () => {
    _workspaceStoreState = makeStoreState(true, "tunnel");
    render(<SidePanel />);
    expect(screen.queryByTestId("sftp-browser")).not.toBeInTheDocument();
  });

  it("renders a labeled region for the panel content", () => {
    _workspaceStoreState = makeStoreState(true, "tunnel");
    render(<SidePanel />);
    expect(
      screen.getByRole("region", { name: "Session panel" }),
    ).toBeInTheDocument();
  });
});

describe("SidePanel — close button when open", () => {
  it("renders a close button when panel is open", () => {
    _workspaceStoreState = makeStoreState(true, "tunnel");
    render(<SidePanel />);
    expect(
      screen.getByRole("button", { name: "Close panel" }),
    ).toBeInTheDocument();
  });

  it("clicking close button calls setPanelOpen(key, false)", () => {
    _workspaceStoreState = makeStoreState(true, "tunnel");
    render(<SidePanel />);
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    expect(mockSetPanelOpen).toHaveBeenCalledWith("profile-1:user-1", false);
  });
});

// ── History section (new) ─────────────────────────────────────────────────────

describe("SidePanel — History button in rail", () => {
  it("renders a History toggle button in the rail", () => {
    render(<SidePanel />);
    expect(
      screen.getByRole("button", { name: "History" }),
    ).toBeInTheDocument();
  });

  it("History button has aria-pressed=false when panel is closed", () => {
    render(<SidePanel />);
    expect(screen.getByRole("button", { name: "History" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("History button has aria-pressed=true when panel is open on history", () => {
    _workspaceStoreState = makeStoreState(true, "history");
    render(<SidePanel />);
    expect(screen.getByRole("button", { name: "History" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("clicking History button calls setPanelSection(key, 'history') and setPanelOpen(key, true)", () => {
    render(<SidePanel />);
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    expect(mockSetPanelSection).toHaveBeenCalledWith(
      "profile-1:user-1",
      "history",
    );
    expect(mockSetPanelOpen).toHaveBeenCalledWith("profile-1:user-1", true);
  });

  it("clicking the already-active History button closes the panel", () => {
    _workspaceStoreState = makeStoreState(true, "history");
    render(<SidePanel />);
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    expect(mockSetPanelOpen).toHaveBeenCalledWith("profile-1:user-1", false);
  });
});

describe("SidePanel — HistoryPanel mount", () => {
  it("renders HistoryPanel when panel is open on history", () => {
    _workspaceStoreState = makeStoreState(true, "history");
    render(<SidePanel />);
    expect(screen.getByTestId("history-panel")).toBeInTheDocument();
  });

  it("does NOT render HistoryPanel when panel section is tunnel", () => {
    _workspaceStoreState = makeStoreState(true, "tunnel");
    render(<SidePanel />);
    expect(screen.queryByTestId("history-panel")).not.toBeInTheDocument();
  });

  it("does NOT render HistoryPanel when panel section is tunnel", () => {
    _workspaceStoreState = makeStoreState(true, "tunnel");
    render(<SidePanel />);
    expect(screen.queryByTestId("history-panel")).not.toBeInTheDocument();
  });

  it("panel title shows 'History' when section is history", () => {
    _workspaceStoreState = makeStoreState(true, "history");
    render(<SidePanel />);
    expect(screen.getByText("History")).toBeInTheDocument();
  });
});
