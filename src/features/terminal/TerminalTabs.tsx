// features/terminal/TerminalTabs.tsx — Multi-tab terminal management
//
// Shows tab bar for multiple terminal channels on the same session.
// Each tab wraps a TerminalView that stays alive when hidden (not destroyed).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSessionStore, type TerminalTab } from "../../stores/sessionStore";
import { TerminalView } from "./TerminalView";
import { useTerminal } from "./useTerminal";
import { useI18n } from "../../lib/i18n";
import type { SessionId } from "../../lib/types";

interface TerminalTabsProps {
  sessionId: SessionId;
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

export function TerminalTabs({ sessionId }: TerminalTabsProps) {
  const { t } = useI18n();
  const { sessions, addTerminalTab, removeTerminalTab, replaceTerminalTab, setActiveTerminal } =
    useSessionStore();
  const { closeTerminal } = useTerminal();

  const session = sessions.get(sessionId);
  if (!session) return null;

  const { terminals, activeTerminalId } = session;

  // Connection info for the info bar
  const hostLabel = useMemo(
    () => `${session.username}@${session.host}`,
    [session.username, session.host],
  );

  // Tick elapsed time every 30s
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(interval);
  }, []);
  const elapsed = formatElapsed(session.connectedAt);

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
  }, [terminals.length, sessionId, addTerminalTab]);

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
    },
    [sessionId, closeTerminal, removeTerminalTab],
  );

  const tabBarRef = useRef<HTMLDivElement>(null);

  return (
    <div className="terminal-tabs">
      {/* Tab bar */}
      <div className="terminal-tabbar" ref={tabBarRef}>
        <div className="terminal-tabbar-scroll">
          {terminals.map((tab) => (
            <div
              key={tab.reactKey}
              className={`terminal-tab ${tab.id === activeTerminalId ? "terminal-tab-active" : ""}`}
              onClick={() => setActiveTerminal(sessionId, tab.id)}
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
          ))}
        </div>
        <button
          className="terminal-tab-new"
          onClick={() => void handleNewTab()}
          title={t("terminal.newTab")}
        >
          +
        </button>
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

      {/* Terminal views — hidden but alive when not active */}
      <div className="terminal-views">
        {terminals.length === 0 ? (
          <div className="terminal-empty">
            <span className="terminal-empty-icon">&#9002;</span>
            <span>{t("terminal.noTerminal")}</span>
          </div>
        ) : (
          terminals.map((tab) => (
            <TerminalView
              key={tab.reactKey}
              sessionId={sessionId}
              terminalId={tab.id.startsWith("pending-") ? null : tab.id}
              onTerminalOpened={(realId) => {
                // M3 fix: Atomic tab replacement — single state update instead
                // of remove+add which caused a visual flash and potential leak.
                // reactKey is preserved so React doesn't remount the component.
                if (tab.id.startsWith("pending-")) {
                  replaceTerminalTab(sessionId, tab.id, {
                    ...tab,
                    id: realId,
                    reactKey: tab.reactKey,
                  });
                }
              }}
              active={tab.id === activeTerminalId}
            />
          ))
        )}
      </div>
    </div>
  );
}
