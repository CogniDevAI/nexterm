// features/history/HistoryPanel.test.tsx
// TDD RED phase — RTL tests for the command history side panel.

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
        "history.empty": "No commands recorded yet",
        "history.captureOff": "Command capture is disabled",
        "history.enableCapture": "Enable capture to start recording commands",
        "history.filter": "Filter commands...",
        "history.filterByHost": "Filter to current host",
        "history.copy": "Copy",
        "history.insert": "Insert",
        "history.execute": "Execute",
        "history.delete": "Delete command",
        "history.clearAll": "Clear all",
        "history.captureToggleLabel": "Capture commands",
        "history.noticeTitle": "Privacy notice",
        "history.noticeMessage":
          "Command history captures everything you type. Passwords entered at prompts may be recorded. You can disable capture or clear history at any time.",
        "history.noticeDismiss": "Got it",
      };
      return labels[k] ?? k;
    },
  }),
}));

// ── commandHistoryStore mock ──────────────────────────────────────────────────
const mockDeleteCommand = vi.fn();
const mockClearAll = vi.fn();
const mockToggleCapture = vi.fn();
const mockDismissNotice = vi.fn();

let _historyStoreState: {
  entries: Array<{
    id: string;
    command: string;
    timestamp: number;
    sessionId: string;
    host: string;
  }>;
  captureEnabled: boolean;
  noticeAcknowledged: boolean;
  addCommand: ReturnType<typeof vi.fn>;
  deleteCommand: ReturnType<typeof vi.fn>;
  clearAll: ReturnType<typeof vi.fn>;
  toggleCapture: ReturnType<typeof vi.fn>;
  dismissNotice: ReturnType<typeof vi.fn>;
};

vi.mock("../../stores/commandHistoryStore", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useCommandHistoryStore: vi.fn((selector?: (s: any) => unknown) => {
    if (typeof selector === "function") {
      return selector(_historyStoreState);
    }
    return _historyStoreState;
  }),
}));

// ── injectSnippet mock ────────────────────────────────────────────────────────
const mockInjectSnippet = vi.fn().mockResolvedValue(undefined);
vi.mock("../snippets/useSnippetInject", () => ({
  injectSnippet: (...args: unknown[]) => mockInjectSnippet(...args),
}));

// ── clipboard mock ────────────────────────────────────────────────────────────
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    ...globalThis.navigator,
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  },
});

import { HistoryPanel } from "./HistoryPanel";
import { useCommandHistoryStore } from "../../stores/commandHistoryStore";

const mockedUseCommandHistoryStore = vi.mocked(useCommandHistoryStore);

function makeEntry(
  id: string,
  command: string,
  host = "10.0.0.1",
  sessionId = "sess-1",
  timestamp = Date.now(),
) {
  return { id, command, timestamp, sessionId, host };
}

function makeStoreState(overrides: Partial<typeof _historyStoreState> = {}) {
  return {
    entries: [],
    captureEnabled: false,
    noticeAcknowledged: true, // suppressed by default in tests unless testing notice
    addCommand: vi.fn(),
    deleteCommand: mockDeleteCommand,
    clearAll: mockClearAll,
    toggleCapture: mockToggleCapture,
    dismissNotice: mockDismissNotice,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  _historyStoreState = makeStoreState();
  mockedUseCommandHistoryStore.mockImplementation(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (selector?: (s: any) => unknown) => {
      if (typeof selector === "function") return selector(_historyStoreState);
      return _historyStoreState;
    },
  );
});

// ── Empty state ───────────────────────────────────────────────────────────────

describe("HistoryPanel — empty state", () => {
  it("shows disabled-state message when captureEnabled is false and entries empty", () => {
    render(<HistoryPanel sessionId="sess-1" terminalId="term-1" host="10.0.0.1" />);
    expect(screen.getByText("Command capture is disabled")).toBeInTheDocument();
  });

  it("shows empty-list message when captureEnabled=true and entries empty", () => {
    _historyStoreState = makeStoreState({ captureEnabled: true, entries: [] });
    render(<HistoryPanel sessionId="sess-1" terminalId="term-1" host="10.0.0.1" />);
    expect(screen.getByText("No commands recorded yet")).toBeInTheDocument();
  });
});

// ── Entry list ────────────────────────────────────────────────────────────────

describe("HistoryPanel — entry list", () => {
  it("renders command text for each entry", () => {
    _historyStoreState = makeStoreState({
      captureEnabled: true,
      entries: [makeEntry("e1", "ls -la"), makeEntry("e2", "git status")],
    });
    render(<HistoryPanel sessionId="sess-1" terminalId="term-1" host="10.0.0.1" />);
    expect(screen.getByText("ls -la")).toBeInTheDocument();
    expect(screen.getByText("git status")).toBeInTheDocument();
  });
});

// ── Filter input ──────────────────────────────────────────────────────────────

describe("HistoryPanel — filter input", () => {
  it("renders a filter input", () => {
    _historyStoreState = makeStoreState({
      captureEnabled: true,
      entries: [makeEntry("e1", "ls -la"), makeEntry("e2", "git status")],
    });
    render(<HistoryPanel sessionId="sess-1" terminalId="term-1" host="10.0.0.1" />);
    expect(screen.getByPlaceholderText("Filter commands...")).toBeInTheDocument();
  });

  it("filters entries by command text", () => {
    _historyStoreState = makeStoreState({
      captureEnabled: true,
      entries: [makeEntry("e1", "ls -la"), makeEntry("e2", "git status")],
    });
    render(<HistoryPanel sessionId="sess-1" terminalId="term-1" host="10.0.0.1" />);
    fireEvent.change(screen.getByPlaceholderText("Filter commands..."), {
      target: { value: "git" },
    });
    expect(screen.queryByText("ls -la")).not.toBeInTheDocument();
    expect(screen.getByText("git status")).toBeInTheDocument();
  });
});

// ── Filter by host ────────────────────────────────────────────────────────────

describe("HistoryPanel — filter by current host", () => {
  it("renders a filter-by-host toggle", () => {
    _historyStoreState = makeStoreState({
      captureEnabled: true,
      entries: [
        makeEntry("e1", "ls", "10.0.0.1"),
        makeEntry("e2", "pwd", "10.0.0.2"),
      ],
    });
    render(<HistoryPanel sessionId="sess-1" terminalId="term-1" host="10.0.0.1" />);
    expect(
      screen.getByRole("checkbox", { name: "Filter to current host" }),
    ).toBeInTheDocument();
  });

  it("shows only entries matching the current host when toggle is checked", () => {
    _historyStoreState = makeStoreState({
      captureEnabled: true,
      entries: [
        makeEntry("e1", "ls", "10.0.0.1"),
        makeEntry("e2", "pwd", "10.0.0.2"),
      ],
    });
    render(<HistoryPanel sessionId="sess-1" terminalId="term-1" host="10.0.0.1" />);
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Filter to current host" }),
    );
    expect(screen.getByText("ls")).toBeInTheDocument();
    expect(screen.queryByText("pwd")).not.toBeInTheDocument();
  });
});

// ── Copy button ───────────────────────────────────────────────────────────────

describe("HistoryPanel — copy button", () => {
  it("copies the command text to clipboard when copy button is clicked", async () => {
    _historyStoreState = makeStoreState({
      captureEnabled: true,
      entries: [makeEntry("e1", "ls -la")],
    });
    render(<HistoryPanel sessionId="sess-1" terminalId="term-1" host="10.0.0.1" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("ls -la");
  });
});

// ── Insert button ─────────────────────────────────────────────────────────────

describe("HistoryPanel — insert button", () => {
  it("calls injectSnippet with mode 'insert' when insert button is clicked", async () => {
    _historyStoreState = makeStoreState({
      captureEnabled: true,
      entries: [makeEntry("e1", "git pull")],
    });
    render(<HistoryPanel sessionId="sess-1" terminalId="term-1" host="10.0.0.1" />);
    fireEvent.click(screen.getByRole("button", { name: "Insert" }));
    expect(mockInjectSnippet).toHaveBeenCalledWith(
      "sess-1",
      "term-1",
      "git pull",
      "insert",
    );
  });
});

// ── Execute button ────────────────────────────────────────────────────────────

describe("HistoryPanel — execute button", () => {
  it("calls injectSnippet with mode 'execute' when execute button is clicked", async () => {
    _historyStoreState = makeStoreState({
      captureEnabled: true,
      entries: [makeEntry("e1", "make build")],
    });
    render(<HistoryPanel sessionId="sess-1" terminalId="term-1" host="10.0.0.1" />);
    fireEvent.click(screen.getByRole("button", { name: "Execute" }));
    expect(mockInjectSnippet).toHaveBeenCalledWith(
      "sess-1",
      "term-1",
      "make build",
      "execute",
    );
  });
});

// ── Delete button ─────────────────────────────────────────────────────────────

describe("HistoryPanel — delete button", () => {
  it("calls store.deleteCommand(id) when delete button is clicked", () => {
    _historyStoreState = makeStoreState({
      captureEnabled: true,
      entries: [makeEntry("entry-xyz", "rm -rf /tmp/test")],
    });
    render(<HistoryPanel sessionId="sess-1" terminalId="term-1" host="10.0.0.1" />);
    fireEvent.click(screen.getByRole("button", { name: "Delete command" }));
    expect(mockDeleteCommand).toHaveBeenCalledWith("entry-xyz");
  });
});

// ── Clear all button ──────────────────────────────────────────────────────────

describe("HistoryPanel — clear all button", () => {
  it("renders a clear-all button", () => {
    _historyStoreState = makeStoreState({
      captureEnabled: true,
      entries: [makeEntry("e1", "ls")],
    });
    render(<HistoryPanel sessionId="sess-1" terminalId="term-1" host="10.0.0.1" />);
    expect(screen.getByRole("button", { name: "Clear all" })).toBeInTheDocument();
  });

  it("calls store.clearAll() when clear-all button is clicked and confirmed", () => {
    _historyStoreState = makeStoreState({
      captureEnabled: true,
      entries: [makeEntry("e1", "ls")],
    });
    // Use window.confirm mock
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<HistoryPanel sessionId="sess-1" terminalId="term-1" host="10.0.0.1" />);
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(mockClearAll).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
  });

  it("does NOT call clearAll when confirmation is cancelled", () => {
    _historyStoreState = makeStoreState({
      captureEnabled: true,
      entries: [makeEntry("e1", "ls")],
    });
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<HistoryPanel sessionId="sess-1" terminalId="term-1" host="10.0.0.1" />);
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(mockClearAll).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

// ── Capture toggle ────────────────────────────────────────────────────────────

describe("HistoryPanel — capture toggle", () => {
  it("renders a capture toggle switch", () => {
    render(<HistoryPanel sessionId="sess-1" terminalId="term-1" host="10.0.0.1" />);
    expect(
      screen.getByRole("checkbox", { name: "Capture commands" }),
    ).toBeInTheDocument();
  });

  it("capture toggle reflects captureEnabled=false", () => {
    render(<HistoryPanel sessionId="sess-1" terminalId="term-1" host="10.0.0.1" />);
    const toggle = screen.getByRole("checkbox", { name: "Capture commands" });
    expect(toggle).not.toBeChecked();
  });

  it("capture toggle reflects captureEnabled=true", () => {
    _historyStoreState = makeStoreState({ captureEnabled: true });
    render(<HistoryPanel sessionId="sess-1" terminalId="term-1" host="10.0.0.1" />);
    const toggle = screen.getByRole("checkbox", { name: "Capture commands" });
    expect(toggle).toBeChecked();
  });

  it("calls store.toggleCapture() when toggle is clicked", () => {
    render(<HistoryPanel sessionId="sess-1" terminalId="term-1" host="10.0.0.1" />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Capture commands" }));
    expect(mockToggleCapture).toHaveBeenCalledOnce();
  });
});

// ── First-use privacy notice ──────────────────────────────────────────────────

describe("HistoryPanel — privacy notice", () => {
  it("shows notice when noticeAcknowledged=false", () => {
    _historyStoreState = makeStoreState({ noticeAcknowledged: false });
    render(<HistoryPanel sessionId="sess-1" terminalId="term-1" host="10.0.0.1" />);
    expect(screen.getByText("Privacy notice")).toBeInTheDocument();
    expect(
      screen.getByText(/Command history captures everything/),
    ).toBeInTheDocument();
  });

  it("hides notice when noticeAcknowledged=true", () => {
    // Default makeStoreState has noticeAcknowledged: true
    render(<HistoryPanel sessionId="sess-1" terminalId="term-1" host="10.0.0.1" />);
    expect(screen.queryByText("Privacy notice")).not.toBeInTheDocument();
  });

  it("calls store.dismissNotice() when 'Got it' button is clicked", () => {
    _historyStoreState = makeStoreState({ noticeAcknowledged: false });
    render(<HistoryPanel sessionId="sess-1" terminalId="term-1" host="10.0.0.1" />);
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(mockDismissNotice).toHaveBeenCalledOnce();
  });
});
