// features/terminal/PaneSplitView.tsx — Split-pane terminal grid
//
// Renders a flat 1D ordered list of pane slots, each containing a TerminalView.
// ONLY rendered when slots.length >= 2 (multi-pane mode).
// Single-pane rendering is handled directly in TerminalTabs (all tabs visible).
//
// Critical invariants (from explore):
//   1. isSplitPane=true: TerminalView is always display:block
//   2. Stable React keys: PaneSlot.id (UUID), never terminalId — avoids remount flicker
//   3. Fit on drag-END only: SplitHandle defers fit until pointer-up
//   4. MAX_PANE_COUNT = 4 enforced in paneLayoutStore
//   5. Focus: clicking a pane calls focusSlot → sessionStore.setActiveTerminal
//   6. Only the focused pane gets active=true (drives real xterm focus)
//   7. a11y: role="region" + aria-label per pane; tabIndex for keyboard focus

import React, { useCallback, useRef } from "react";
import { usePaneLayoutStore } from "../../stores/paneLayoutStore";
import { useSessionStore } from "../../stores/sessionStore";
import { TerminalView } from "./TerminalView";
import { SplitHandle } from "./SplitHandle";
import { useI18n } from "../../lib/i18n";
import type { SessionId } from "../../lib/types";

interface PaneSplitViewProps {
  sessionId: SessionId;
  onTerminalOpened?: (slotId: string, terminalId: string) => void;
  /** Called when the user clicks the × on a pane. Non-destructive: removes
   *  the slot from the layout but keeps the terminal tab alive. */
  onClosePane?: (slotId: string) => void;
  /** Called when the user clicks the direction-toggle button. */
  onDirectionToggle?: () => void;
}

export function PaneSplitView({
  sessionId,
  onTerminalOpened,
  onClosePane,
  onDirectionToggle,
}: PaneSplitViewProps) {
  const layout = usePaneLayoutStore((s) => s.layouts[sessionId]);
  const { focusSlot, setRatio, assignTerminal } = usePaneLayoutStore.getState();
  const { setActiveTerminal, sessions } = useSessionStore();
  const { t } = useI18n();

  const containerRef = useRef<HTMLDivElement>(null);

  const handlePaneClick = useCallback(
    (slotId: string, terminalId: string | null) => {
      focusSlot(sessionId, slotId);
      if (terminalId) {
        setActiveTerminal(sessionId, terminalId);
      }
    },
    [sessionId, focusSlot, setActiveTerminal],
  );

  const handleTerminalOpened = useCallback(
    (slotId: string, realTerminalId: string) => {
      assignTerminal(sessionId, slotId, realTerminalId);

      // MINOR-2: if this slot is the focused one, update activeTerminalId now
      // so the session store doesn't lag behind the pane layout.
      const currentLayout = usePaneLayoutStore.getState().layouts[sessionId];
      if (currentLayout?.focusedSlotId === slotId) {
        setActiveTerminal(sessionId, realTerminalId);
      }

      onTerminalOpened?.(slotId, realTerminalId);
    },
    [sessionId, assignTerminal, setActiveTerminal, onTerminalOpened],
  );

  // Alt+Arrow keyboard navigation between panes.
  // Alt modifier avoids conflicting with terminal arrow keys (used for line navigation).
  const handlePaneKeyDown = useCallback(
    (e: React.KeyboardEvent, currentIndex: number) => {
      if (!e.altKey) return;
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;

      const currentLayout = usePaneLayoutStore.getState().layouts[sessionId];
      if (!currentLayout) return;

      e.preventDefault();
      e.stopPropagation();

      const targetIdx =
        e.key === "ArrowRight"
          ? Math.min(currentIndex + 1, currentLayout.slots.length - 1)
          : Math.max(currentIndex - 1, 0);

      const targetSlot = currentLayout.slots[targetIdx];
      if (!targetSlot) return;

      focusSlot(sessionId, targetSlot.id);
      if (targetSlot.terminalId) {
        setActiveTerminal(sessionId, targetSlot.terminalId);
      }
    },
    [sessionId, focusSlot, setActiveTerminal],
  );

  const handleDragEnd = useCallback(
    (leftSlotId: string, rightSlotId: string, deltaFraction: number) => {
      if (!layout) return;
      const leftSlot = layout.slots.find((s) => s.id === leftSlotId);
      const rightSlot = layout.slots.find((s) => s.id === rightSlotId);
      if (!leftSlot || !rightSlot) return;

      // Redistribute ratio between the two adjacent panes
      const combined = leftSlot.ratio + rightSlot.ratio;
      const newLeft = Math.max(0.1, Math.min(combined - 0.1, leftSlot.ratio + deltaFraction));
      const newRight = combined - newLeft;

      setRatio(sessionId, leftSlotId, newLeft);
      setRatio(sessionId, rightSlotId, newRight);
    },
    [layout, sessionId, setRatio],
  );

  // No layout yet, or layout is in single-pane mode — render nothing.
  // Single-pane rendering (all tabs, display:block/none) is TerminalTabs' responsibility.
  // PaneSplitView is only rendered when slots >= 2.
  if (!layout || layout.slots.length < 2) return null;

  const { slots, direction, focusedSlotId } = layout;
  const session = sessions.get(sessionId);

  const containerSizePx = containerRef.current
    ? direction === "horizontal"
      ? containerRef.current.offsetWidth
      : containerRef.current.offsetHeight
    : 0;

  return (
    <div
      ref={containerRef}
      className={`terminal-split terminal-split-${direction}`}
    >
      {/* Direction toggle button — visible only in split mode */}
      {onDirectionToggle && (
        <button
          className="terminal-split-direction-toggle"
          onClick={onDirectionToggle}
          title={direction === "horizontal"
            ? t("terminal.splitVertical")
            : t("terminal.splitHorizontal")}
          aria-label={direction === "horizontal"
            ? t("terminal.splitVertical")
            : t("terminal.splitHorizontal")}
        >
          {direction === "horizontal" ? "⊠" : "⊟"}
        </button>
      )}

      {slots.map((slot, i) => {
        // MAJOR-2 fix: only the focused pane gets active=true
        // This ensures only the focused pane's terminal receives real keyboard focus.
        const isFocused = slot.id === focusedSlotId;
        const isActive = isFocused || slot.terminalId === session?.activeTerminalId;
        const isLast = i === slots.length - 1;
        const flexStyle = { flex: slot.ratio };

        return (
          <React.Fragment key={slot.id}>
            <div
              className="terminal-split-pane"
              style={flexStyle}
              data-focused={isFocused ? "true" : "false"}
              role="region"
              aria-label={`Terminal pane ${i + 1}`}
              tabIndex={0}
              onClick={() => handlePaneClick(slot.id, slot.terminalId)}
              onFocus={() => handlePaneClick(slot.id, slot.terminalId)}
              onKeyDown={(e) => handlePaneKeyDown(e, i)}
            >
              {/* Per-pane close button — non-destructive (removes split, keeps tab) */}
              {onClosePane && (
                <button
                  className="terminal-split-pane-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClosePane(slot.id);
                  }}
                  title={t("terminal.closePane")}
                  aria-label={t("terminal.closePane")}
                >
                  ×
                </button>
              )}
              <TerminalView
                sessionId={sessionId}
                terminalId={slot.terminalId}
                onTerminalOpened={(realId) => handleTerminalOpened(slot.id, realId)}
                active={isActive}
                isSplitPane={true}
              />
            </div>
            {!isLast && (
              <SplitHandle
                direction={direction}
                containerSize={containerSizePx}
                onDragEnd={(delta) => {
                  const nextSlot = slots[i + 1];
                  if (nextSlot) handleDragEnd(slot.id, nextSlot.id, delta);
                }}
              />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}
