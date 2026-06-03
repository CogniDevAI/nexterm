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
        "panel.close": "Close panel",
        "panel.open": "Open panel",
        "panel.region": "Session panel",
      };
      return labels[k] ?? k;
    },
  }),
}));

// ── workspaceStore mock ───────────────────────────────────────────────────────
const mockSetPanelSection = vi.fn();
const mockSetPanelOpen = vi.fn();

vi.mock("../../stores/workspaceStore", () => ({
  useWorkspaceStore: vi.fn(),
  buildWorkspaceKey: vi.fn((p: string, u: string) => `${p}:${u}`),
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

import { SidePanel } from "./SidePanel";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useSessionStore } from "../../stores/sessionStore";

const mockedUseWorkspaceStore = vi.mocked(useWorkspaceStore);
const mockedUseSessionStore = vi.mocked(useSessionStore);

function makeStoreState(
  panelOpen = false,
  panelSection: "sftp" | "tunnel" | null = null,
) {
  return {
    workspaces: {
      "profile-1:user-1": {
        key: "profile-1:user-1",
        profileId: "profile-1",
        userId: "user-1",
        activeFeature: "terminal" as const,
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
        updatedAt: Date.now(),
      },
    },
    setPanelSection: mockSetPanelSection,
    setPanelOpen: mockSetPanelOpen,
    getOrCreateWorkspace: vi.fn(),
    setActiveFeature: vi.fn(),
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
    activeFeature: "terminal" as const,
    startupPreview: null,
    addSession: vi.fn(),
    removeSession: vi.fn(),
    setActiveSession: vi.fn(),
    setActiveFeature: vi.fn(),
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
  mockedUseWorkspaceStore.mockReturnValue(makeStoreState() as ReturnType<typeof useWorkspaceStore>);
  mockedUseSessionStore.mockReturnValue(makeSessionState() as ReturnType<typeof useSessionStore>);
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("SidePanel — icon rail a11y", () => {
  it("renders a toolbar region with aria-label", () => {
    render(<SidePanel />);
    expect(screen.getByRole("toolbar")).toBeInTheDocument();
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

  it("SFTP button has aria-pressed=true when panel is open on sftp", () => {
    mockedUseWorkspaceStore.mockReturnValue(
      makeStoreState(true, "sftp") as ReturnType<typeof useWorkspaceStore>,
    );
    render(<SidePanel />);
    expect(screen.getByRole("button", { name: "Files" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("Tunnels button has aria-pressed=true when panel is open on tunnel", () => {
    mockedUseWorkspaceStore.mockReturnValue(
      makeStoreState(true, "tunnel") as ReturnType<typeof useWorkspaceStore>,
    );
    render(<SidePanel />);
    expect(screen.getByRole("button", { name: "Tunnels" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

describe("SidePanel — panel toggle interactions", () => {
  it("clicking SFTP button calls setPanelSection(key, sftp) and setPanelOpen(key, true)", () => {
    render(<SidePanel />);
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    expect(mockSetPanelSection).toHaveBeenCalledWith(
      "profile-1:user-1",
      "sftp",
    );
    expect(mockSetPanelOpen).toHaveBeenCalledWith("profile-1:user-1", true);
  });

  it("clicking an already-active button closes the panel", () => {
    mockedUseWorkspaceStore.mockReturnValue(
      makeStoreState(true, "sftp") as ReturnType<typeof useWorkspaceStore>,
    );
    render(<SidePanel />);
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    expect(mockSetPanelOpen).toHaveBeenCalledWith("profile-1:user-1", false);
  });

  it("clicking Tunnels button when SFTP is active switches section", () => {
    mockedUseWorkspaceStore.mockReturnValue(
      makeStoreState(true, "sftp") as ReturnType<typeof useWorkspaceStore>,
    );
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
  it("renders SftpBrowser when panel is open on sftp", () => {
    mockedUseWorkspaceStore.mockReturnValue(
      makeStoreState(true, "sftp") as ReturnType<typeof useWorkspaceStore>,
    );
    render(<SidePanel />);
    expect(screen.getByTestId("sftp-browser")).toBeInTheDocument();
  });

  it("does NOT render SftpBrowser when panel section is tunnel", () => {
    mockedUseWorkspaceStore.mockReturnValue(
      makeStoreState(true, "tunnel") as ReturnType<typeof useWorkspaceStore>,
    );
    render(<SidePanel />);
    expect(screen.queryByTestId("sftp-browser")).not.toBeInTheDocument();
  });

  it("renders TunnelManager when panel is open on tunnel", () => {
    mockedUseWorkspaceStore.mockReturnValue(
      makeStoreState(true, "tunnel") as ReturnType<typeof useWorkspaceStore>,
    );
    render(<SidePanel />);
    expect(screen.getByTestId("tunnel-manager")).toBeInTheDocument();
  });

  it("passes sessionId to SftpBrowser", () => {
    mockedUseWorkspaceStore.mockReturnValue(
      makeStoreState(true, "sftp") as ReturnType<typeof useWorkspaceStore>,
    );
    render(<SidePanel />);
    expect(screen.getByTestId("sftp-browser")).toHaveAttribute(
      "data-session-id",
      "sid-1",
    );
  });

  it("renders a labeled region for the panel content", () => {
    mockedUseWorkspaceStore.mockReturnValue(
      makeStoreState(true, "sftp") as ReturnType<typeof useWorkspaceStore>,
    );
    render(<SidePanel />);
    expect(
      screen.getByRole("region", { name: "Session panel" }),
    ).toBeInTheDocument();
  });
});

describe("SidePanel — close button when open", () => {
  it("renders a close button when panel is open", () => {
    mockedUseWorkspaceStore.mockReturnValue(
      makeStoreState(true, "sftp") as ReturnType<typeof useWorkspaceStore>,
    );
    render(<SidePanel />);
    expect(
      screen.getByRole("button", { name: "Close panel" }),
    ).toBeInTheDocument();
  });

  it("clicking close button calls setPanelOpen(key, false)", () => {
    mockedUseWorkspaceStore.mockReturnValue(
      makeStoreState(true, "sftp") as ReturnType<typeof useWorkspaceStore>,
    );
    render(<SidePanel />);
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    expect(mockSetPanelOpen).toHaveBeenCalledWith("profile-1:user-1", false);
  });
});
