// TerminalView.test.tsx — TDD: find-bar integration, right-click paste

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";

// ── Global stubs (ResizeObserver, localStorage) ─────────────────────────────
vi.hoisted(() => {
  // ResizeObserver is not available in jsdom
  globalThis.ResizeObserver = class MockResizeObserver {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
    constructor(_callback: ResizeObserverCallback) {}
  };
});

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
      get length() { return store.size; },
    },
  });
});

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("../../lib/tauri", () => ({
  tauriInvoke: vi.fn().mockResolvedValue("term-id-test"),
}));

vi.mock("@tauri-apps/api/core", () => {
  class MockChannel {
    onmessage = null;
  }
  return { Channel: MockChannel, invoke: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("@xterm/xterm", () => {
  class MockTerminal {
    loadAddon = vi.fn();
    open = vi.fn();
    cols = 80;
    rows = 24;
    onData = vi.fn();
    onBinary = vi.fn();
    onSelectionChange = vi.fn();
    focus = vi.fn();
    dispose = vi.fn();
    write = vi.fn();
    writeln = vi.fn();
    element = document.createElement("div");
    options = {};
    hasSelection = vi.fn().mockReturnValue(false);
    getSelection = vi.fn().mockReturnValue("");
    attachCustomKeyEventHandler = vi.fn();
  }
  return { Terminal: MockTerminal };
});

vi.mock("@xterm/addon-fit", () => {
  class MockFitAddon {
    fit = vi.fn();
    dispose = vi.fn();
  }
  return { FitAddon: MockFitAddon };
});

vi.mock("@xterm/addon-web-links", () => {
  class MockWebLinksAddon {
    dispose = vi.fn();
  }
  return { WebLinksAddon: MockWebLinksAddon };
});

vi.mock("@xterm/addon-search", () => {
  class MockSearchAddon {
    activate = vi.fn();
    dispose = vi.fn();
    findNext = vi.fn().mockReturnValue(false);
    findPrevious = vi.fn().mockReturnValue(false);
    onDidChangeResults = vi.fn().mockReturnValue({ dispose: vi.fn() });
  }
  return { SearchAddon: MockSearchAddon };
});

// Mock FindBar so we can check it renders without real DOM complexity
vi.mock("./FindBar", () => ({
  FindBar: ({ query, onClose }: { query: string; onClose: () => void }) => (
    <div data-testid="find-bar" data-query={query}>
      <button data-testid="find-bar-close" onClick={onClose}>close</button>
    </div>
  ),
}));

vi.mock("../../lib/i18n", () => ({
  useI18n: () => ({ t: (k: string) => k }),
}));

// Mock navigator.clipboard
const mockClipboardReadText = vi.fn().mockResolvedValue("pasted text");
Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: {
    writeText: vi.fn().mockResolvedValue(undefined),
    readText: mockClipboardReadText,
  },
});

import { TerminalView } from "./TerminalView";
import { registerFindBarOpener, _testGetFindBarOpener } from "./useTerminal";

function renderTerminalView(props?: { active?: boolean }) {
  return render(
    <TerminalView
      sessionId="sess-1"
      terminalId={null}
      onTerminalOpened={vi.fn()}
      active={props?.active ?? true}
    />,
  );
}

describe("TerminalView — find-bar integration", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders without the find-bar by default", async () => {
    renderTerminalView();
    await act(async () => {});
    expect(screen.queryByTestId("find-bar")).toBeNull();
  });

  it("shows the find-bar when the registered opener callback is invoked", async () => {
    const onTerminalOpened = vi.fn();
    render(
      <TerminalView
        sessionId="sess-opener"
        terminalId={null}
        onTerminalOpened={onTerminalOpened}
        active={true}
      />,
    );

    // Wait for openTerminal to complete and register a terminalId
    await waitFor(() => expect(onTerminalOpened).toHaveBeenCalled());
    const termId: string = onTerminalOpened.mock.calls[0]?.[0] as string;

    // Confirm find-bar is not visible before the opener fires
    expect(screen.queryByTestId("find-bar")).toBeNull();

    // Retrieve the actual React setState-based opener that TerminalView registered
    const opener = _testGetFindBarOpener(termId);
    expect(opener).not.toBeNull();

    // Invoke the opener — this drives the actual find-bar open state
    act(() => {
      opener?.();
    });

    // Find-bar should now be visible
    expect(screen.getByTestId("find-bar")).toBeTruthy();
  });

  it("closes the find-bar when onClose is called", async () => {
    const onTerminalOpened = vi.fn();
    render(
      <TerminalView
        sessionId="sess-close"
        terminalId={null}
        onTerminalOpened={onTerminalOpened}
        active={true}
      />,
    );

    await waitFor(() => expect(onTerminalOpened).toHaveBeenCalled());
    const termId: string = onTerminalOpened.mock.calls[0]?.[0] as string;

    // Open the find-bar
    const opener = _testGetFindBarOpener(termId);
    act(() => { opener?.(); });
    expect(screen.getByTestId("find-bar")).toBeTruthy();

    // Close it via the close button
    act(() => {
      screen.getByTestId("find-bar-close").click();
    });
    expect(screen.queryByTestId("find-bar")).toBeNull();
  });
});

describe("TerminalView — opener registration lifecycle", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("registers an opener callback after mount that is non-null", async () => {
    const onTerminalOpened = vi.fn();
    render(
      <TerminalView
        sessionId="sess-reg"
        terminalId={null}
        onTerminalOpened={onTerminalOpened}
        active={true}
      />,
    );
    await waitFor(() => expect(onTerminalOpened).toHaveBeenCalled());
    const termId: string = onTerminalOpened.mock.calls[0]?.[0] as string;

    // The opener slot must be populated by TerminalView via registerFindBarOpener
    expect(_testGetFindBarOpener(termId)).toBeTypeOf("function");
  });

  it("re-registering with a different callback replaces the previous one (no-throw)", async () => {
    const onTerminalOpened = vi.fn();
    render(
      <TerminalView
        sessionId="sess-rereg"
        terminalId={null}
        onTerminalOpened={onTerminalOpened}
        active={true}
      />,
    );
    await waitFor(() => expect(onTerminalOpened).toHaveBeenCalled());
    const termId: string = onTerminalOpened.mock.calls[0]?.[0] as string;

    const newFn = vi.fn();
    expect(() => registerFindBarOpener(termId, newFn)).not.toThrow();
    expect(_testGetFindBarOpener(termId)).toBe(newFn);
  });
});

describe("TerminalView — wrapper structure", () => {
  it("renders a terminal-wrapper element", async () => {
    const { container } = renderTerminalView();
    await act(async () => {});
    expect(container.querySelector(".terminal-wrapper")).not.toBeNull();
  });

  it("renders the terminal-container inside the wrapper", async () => {
    const { container } = renderTerminalView();
    await act(async () => {});
    expect(container.querySelector(".terminal-container")).not.toBeNull();
  });
});

describe("TerminalView — screen-reader accessibility", () => {
  it("gives the terminal container an accessible name via aria-label", async () => {
    const { container } = renderTerminalView();
    await act(async () => {});
    const termContainer = container.querySelector(".terminal-container");
    expect(termContainer).not.toBeNull();
    // useI18n is mocked to echo the key, so the label resolves to the key string.
    expect(termContainer).toHaveAttribute("aria-label", "terminal.ariaLabel");
  });

  it("exposes the terminal container as an application role for assistive tech", async () => {
    const { container } = renderTerminalView();
    await act(async () => {});
    const termContainer = container.querySelector(".terminal-container");
    expect(termContainer).toHaveAttribute("role", "application");
  });

  it("renders a polite live region for connection status announcements", async () => {
    const { container } = renderTerminalView();
    await act(async () => {});
    const status = container.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status).toHaveAttribute("aria-live", "polite");
    // Visually hidden so it only reaches assistive technology.
    expect(status).toHaveClass("sr-only");
  });
});
