// features/terminal/TerminalTabs.tsx — Multi-tab terminal management
//
// Shows tab bar for multiple terminal channels on the same session.
// Each tab wraps a TerminalView that stays alive when hidden (not destroyed).
//
// Rendering model (v2 — correct):
//   Panes are a VIEW over the existing session tabs.
//   - Single-pane (slots <= 1): render ALL tabs via TerminalView with isSplitPane=false.
//     Active tab is display:block, inactive tabs display:none. Pane layout is ignored.
//     This is IDENTICAL to pre-split behavior and restores multi-tab behavior.
//   - Multi-pane (slots >= 2): render PaneSplitView, each slot maps to one terminal.
//
// Split reconciliation:
//   - "+" new tab: adds a tab only (does NOT add a slot). Single-pane mode shows it.
//   - Split button: adds a new terminal + slot. Layout switches to multi-pane.
//   - Close TAB (× in tab bar): removes tab + if slot found → removes slot too.
//     When slots drop below 2, view returns to single-pane automatically.
//   - Close PANE (× on each pane): removes slot only (tab stays alive). Non-destructive.

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useSessionStore, type TerminalTab } from "../../stores/sessionStore";
import { usePaneLayoutStore, MAX_PANE_COUNT } from "../../stores/paneLayoutStore";
import { PaneSplitView } from "./PaneSplitView";
import { TerminalView } from "./TerminalView";
import { useTerminal } from "./useTerminal";
import { useI18n } from "../../lib/i18n";
import type { SessionId } from "../../lib/types";

interface TerminalTabsProps {
  sessionId: SessionId;
  onOpenSnippets?: () => void;
}

/** Format elapsed time since a timestamp into a human-readable string */
function formatElapsed(connectedAt: number): string {
  const diff = Math.max(0, Math.floor((Date.now() - connectedAt) / 1000));
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function TerminalTabs({ sessionId, onOpenSnippets }: TerminalTabsProps) {
  const { t } = useI18n();
  const { sessions, addTerminalTab, removeTerminalTab, replaceTerminalTab, setActiveTerminal } =
    useSessionStore();
  const { closeTerminal } = useTerminal();
  const {
    openLayout,
    removeLayout,
    splitSlot,
    closeSlot,
    assignTerminal,
    setDirection,
    layouts: paneLayouts,
  } = usePaneLayoutStore();

  // Read session — may be undefined after disconnect/session-switch.
  // ALL hooks must run unconditionally before any early return so the
  // hook count stays stable across renders (Rules of Hooks).
  const session = sessions.get(sessionId);

  // Null-safe derived values — used by hooks below
  const terminals = session?.terminals ?? [];
  const activeTerminalId = session?.activeTerminalId;
  const paneLayout = paneLayouts[sessionId];
  const paneCount = paneLayout?.slots.length ?? 0;

  // Connection info for the info bar
  const hostLabel = useMemo(
    () => (session ? `${session.username}@${session.host}` : ""),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session?.username, session?.host],
  );

  // Tick elapsed time every 30s
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(interval);
  }, []);
  const elapsed = session ? formatElapsed(session.connectedAt) : "";

  // Derive next label number from existing labels to avoid gaps
  const getNextTerminalNumber = useCallback((): number => {
    const existingNumbers = terminals
      .map((t) => {
        const match = t.label.match(/^Terminal\s+(\d+)$/);
        return match?.[1] ? parseInt(match[1], 10) : 0;
      })
      .filter((n) => n > 0);
    return existingNumbers.length > 0 ? Math.max(...existingNumbers) + 1 : 1;
  }, [terminals]);

  // Auto-create the first pending tab when session has no terminals.
  // This replaces the old `showInitialTerminal` pattern which rendered
  // a TerminalView outside the `terminals.map(...)` — that TerminalView
  // would immediately unmount when onTerminalOpened added a tab to the store,
  // destroying the xterm.js DOM container and leaving the screen blank.
  const autoCreatedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!session) return;
    if (terminals.length === 0 && autoCreatedRef.current !== sessionId) {
      autoCreatedRef.current = sessionId;
      const stableKey = crypto.randomUUID();
      const pendingId = `pending-${stableKey}`;
      addTerminalTab(sessionId, {
        id: pendingId,
        label: "Terminal 1",
        sessionId,
        reactKey: stableKey,
      });
    }
  }, [session, terminals.length, sessionId, addTerminalTab]);

  // Initialize pane layout once the first terminal is present.
  // This runs after the auto-create effect above, so by the time we look up
  // terminals[0] it will be the pending tab that was just added.
  useEffect(() => {
    if (!session) return;
    const firstTab = terminals[0];
    if (!firstTab) return;
    if (paneLayouts[sessionId]) return; // already initialized

    // Use the current terminalId (or null for pending tabs — assignTerminal
    // will update it when the xterm opens via the onTerminalOpened callback).
    const initialTerminalId = firstTab.id.startsWith("pending-") ? null : firstTab.id;
    openLayout(sessionId, initialTerminalId ?? firstTab.id);
  }, [session, terminals, sessionId, paneLayouts, openLayout]);

  // Remove the pane layout when this component unmounts (session closed / navigated away)
  useEffect(() => {
    return () => {
      removeLayout(sessionId);
    };
  }, [sessionId, removeLayout]);

  const handleNewTab = useCallback(async () => {
    const nextNum = getNextTerminalNumber();
    const stableKey = crypto.randomUUID();
    const pendingId = `pending-${stableKey}`;
    addTerminalTab(sessionId, {
      id: pendingId,
      label: `Terminal ${nextNum}`,
      sessionId,
      reactKey: stableKey,
    });
  }, [sessionId, addTerminalTab, getNextTerminalNumber]);

  const handleCloseTab = useCallback(
    async (tab: TerminalTab) => {
      if (!tab.id.startsWith("pending-")) {
        await closeTerminal(tab.id, sessionId);
      }
      removeTerminalTab(sessionId, tab.id);
      // If this tab was assigned to a pane slot, remove that slot too.
      // This keeps the pane layout and tab list in sync.
      // When slots drop below 2 the view returns to single-pane mode automatically.
      const currentLayout = usePaneLayoutStore.getState().layouts[sessionId];
      if (currentLayout) {
        const matchingSlot = currentLayout.slots.find((s) => s.terminalId === tab.id);
        if (matchingSlot && currentLayout.slots.length > 1) {
          closeSlot(sessionId, matchingSlot.id);
        }
      }
    },
    [sessionId, closeTerminal, removeTerminalTab, closeSlot],
  );

  // Split the active pane: add a new pending tab AND a new pane slot.
  const handleSplit = useCallback(async () => {
    const currentLayout = usePaneLayoutStore.getState().layouts[sessionId];
    if (!currentLayout) return;
    if (currentLayout.slots.length >= MAX_PANE_COUNT) return;

    // Find the focused slot to split after
    const focusedSlotId = currentLayout.focusedSlotId;

    // Add a new pending terminal tab (mirrors handleNewTab)
    const nextNum = getNextTerminalNumber();
    const stableKey = crypto.randomUUID();
    const pendingId = `pending-${stableKey}`;
    addTerminalTab(sessionId, {
      id: pendingId,
      label: `Terminal ${nextNum}`,
      sessionId,
      reactKey: stableKey,
    });

    // Add a new pane slot in the layout
    splitSlot(sessionId, focusedSlotId);

    // Link the pending tab to the new slot (the last slot after split)
    // assignTerminal will be called again when the real terminal opens via
    // PaneSplitView's onTerminalOpened → but we pre-link with pending so
    // PaneSplitView can render the TerminalView immediately
    const newLayout = usePaneLayoutStore.getState().layouts[sessionId];
    if (newLayout) {
      const lastSlot = newLayout.slots[newLayout.slots.length - 1];
      if (lastSlot) {
        assignTerminal(sessionId, lastSlot.id, pendingId);
      }
    }
  }, [sessionId, addTerminalTab, splitSlot, assignTerminal, getNextTerminalNumber]);

  // Close a pane slot (non-destructive: removes the slot from the split view,
  // keeps the terminal tab alive and reachable from the tab bar).
  // When slots drop below 2, the view returns to single-pane mode automatically.
  const handleClosePane = useCallback(
    (slotId: string) => {
      const currentLayout = usePaneLayoutStore.getState().layouts[sessionId];
      if (!currentLayout) return;
      if (currentLayout.slots.length <= 1) return; // never remove the last slot
      closeSlot(sessionId, slotId);
    },
    [sessionId, closeSlot],
  );

  // Toggle split direction between horizontal and vertical.
  const handleDirectionToggle = useCallback(() => {
    const currentLayout = usePaneLayoutStore.getState().layouts[sessionId];
    if (!currentLayout) return;
    const next = currentLayout.direction === "horizontal" ? "vertical" : "horizontal";
    setDirection(sessionId, next);
  }, [sessionId, setDirection]);

  // When a terminal opens via PaneSplitView, sync the slot's terminalId with the
  // real (non-pending) ID. Also handle the tab replacement (M3 fix pattern).
  const handlePaneSplitTerminalOpened = useCallback(
    (slotId: string, realId: string) => {
      // Find the pending tab that corresponds to this slot
      const currentLayout = usePaneLayoutStore.getState().layouts[sessionId];
      const slot = currentLayout?.slots.find((s) => s.id === slotId);
      if (slot?.terminalId?.startsWith("pending-")) {
        replaceTerminalTab(sessionId, slot.terminalId, {
          id: realId,
          label:
            sessions
              .get(sessionId)
              ?.terminals.find((t) => t.id === slot.terminalId)?.label ?? `Terminal`,
          sessionId,
          reactKey: slot.terminalId.replace("pending-", ""),
        });
        assignTerminal(sessionId, slotId, realId);
      }
    },
    [sessionId, replaceTerminalTab, assignTerminal, sessions],
  );

  const tabBarRef = useRef<HTMLDivElement>(null);
  // Roving-tabindex refs so keyboard navigation can move DOM focus.
  // Declared before the early return to keep the hook order stable.
  const tabRefs = useRef<(HTMLDivElement | null)[]>([]);

  // WAI-ARIA tabs keyboard pattern: ArrowLeft/Right move (no wrap),
  // Home → first, End → last. Selection follows focus to match click behavior.
  // Defined as a hook-free closure after the refs so it captures current values.
  const handleTabKeyDown = useCallback(
    (e: KeyboardEvent, index: number) => {
      const move = (target: number) => {
        const tab = terminals[target];
        if (!tab) return;
        e.preventDefault();
        setActiveTerminal(sessionId, tab.id);
        tabRefs.current[target]?.focus();
      };
      switch (e.key) {
        case "ArrowRight":
          move(Math.min(index + 1, terminals.length - 1));
          break;
        case "ArrowLeft":
          move(Math.max(index - 1, 0));
          break;
        case "Home":
          move(0);
          break;
        case "End":
          move(terminals.length - 1);
          break;
      }
    },
    [terminals, sessionId, setActiveTerminal],
  );

  // All hooks have run — safe to early-return now
  if (!session) return null;

  return (
    <div className="terminal-tabs">
      {/* Tab bar */}
      <div className="terminal-tabbar" ref={tabBarRef}>
        <div className="terminal-tabbar-scroll" role="tablist">
          {terminals.map((tab, i) => {
            const isActive = tab.id === activeTerminalId;
            return (
              <div
                key={tab.reactKey}
                ref={(el) => {
                  tabRefs.current[i] = el;
                }}
                role="tab"
                aria-selected={isActive}
                aria-label={tab.label}
                tabIndex={isActive ? 0 : -1}
                className={`terminal-tab ${isActive ? "terminal-tab-active" : ""}`}
                onClick={() => setActiveTerminal(sessionId, tab.id)}
                onKeyDown={(e) => handleTabKeyDown(e, i)}
              >
                <span className="terminal-tab-label">{tab.label}</span>
                <button
                  className="terminal-tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleCloseTab(tab);
                  }}
                  title={t("terminal.closeTab")}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
        <button
          className="terminal-tab-new"
          onClick={() => void handleNewTab()}
          title={t("terminal.newTab")}
        >
          +
        </button>
        <button
          className="terminal-tab-split"
          onClick={() => void handleSplit()}
          title={t("terminal.splitHorizontal")}
          disabled={paneCount >= MAX_PANE_COUNT}
          aria-label={t("terminal.splitHorizontal")}
        >
          ⊟
        </button>
        {paneCount >= 2 && (
          <button
            className="terminal-tab-split-direction"
            onClick={handleDirectionToggle}
            title={
              paneLayout?.direction === "horizontal"
                ? t("terminal.splitVertical")
                : t("terminal.splitHorizontal")
            }
            aria-label={
              paneLayout?.direction === "horizontal"
                ? t("terminal.splitVertical")
                : t("terminal.splitHorizontal")
            }
          >
            {paneLayout?.direction === "horizontal" ? "⊠" : "⊟"}
          </button>
        )}
        {onOpenSnippets && (
          <button
            className="terminal-tab-snippets"
            onClick={onOpenSnippets}
            title={t("snippets.openSnippets")}
            aria-label={t("snippets.openSnippets")}
          >
            §
          </button>
        )}
      </div>

      {/* Connection info bar */}
      <div className="terminal-infobar">
        <span className="terminal-infobar-dot" />
        <span className="terminal-infobar-host">{hostLabel}</span>
        <span className="terminal-infobar-sep">&middot;</span>
        <span className="terminal-infobar-elapsed">
          {t("terminal.connected")} {elapsed}
        </span>
        <span className="terminal-infobar-sep">&middot;</span>
        <span className="terminal-infobar-id" title={sessionId}>
          {sessionId.slice(0, 8)}
        </span>
      </div>

      {/* Terminal views — rendering mode depends on split state:
          - Single-pane (slots <= 1 OR no layout): render ALL tabs via TerminalView
            with isSplitPane=false → display:block/none active/inactive toggle.
            This is IDENTICAL to pre-split behavior. The pane layout is IGNORED.
          - Multi-pane (slots >= 2): render PaneSplitView over the slots.
            Each slot maps to one TerminalView with isSplitPane=true. */}
      <div className="terminal-views">
        {terminals.length === 0 ? (
          <div className="terminal-empty">
            <span className="terminal-empty-icon">&#9002;</span>
            <span>{t("terminal.noTerminal")}</span>
          </div>
        ) : paneCount >= 2 ? (
          <PaneSplitView
            sessionId={sessionId}
            onTerminalOpened={handlePaneSplitTerminalOpened}
            onClosePane={handleClosePane}
          />
        ) : (
          // Single-pane mode: render all tabs, show only the active one.
          // This preserves the multi-tab display:block/none behavior exactly
          // and is NOT affected by the pane layout store at all.
          terminals.map((tab) => {
            const isActive = tab.id === activeTerminalId;
            return (
              <TerminalView
                key={tab.reactKey}
                sessionId={sessionId}
                terminalId={tab.id.startsWith("pending-") ? null : tab.id}
                onTerminalOpened={(realId) => {
                  // Replace the pending tab entry with the real one
                  if (tab.id.startsWith("pending-")) {
                    replaceTerminalTab(sessionId, tab.id, {
                      id: realId,
                      label: tab.label,
                      sessionId,
                      reactKey: tab.reactKey,
                    });
                  }
                  // Keep the pane layout slot[0] in sync with the first real terminal
                  const currentLayout = usePaneLayoutStore.getState().layouts[sessionId];
                  if (currentLayout) {
                    const pendingSlot = currentLayout.slots.find(
                      (s) => s.terminalId === tab.id || s.terminalId === null,
                    );
                    if (pendingSlot) {
                      assignTerminal(sessionId, pendingSlot.id, realId);
                    }
                  }
                  setActiveTerminal(sessionId, realId);
                }}
                active={isActive}
                isSplitPane={false}
                reactKey={tab.reactKey}
              />
            );
          })
        )}
      </div>
    </div>
  );
}
