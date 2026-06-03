// features/terminal/PaneSplitView.tsx — Split-pane terminal grid
//
// Renders a flat 1D ordered list of pane slots, each containing a TerminalView.
// When only one slot exists: renders the TerminalView directly (no split chrome)
// so single-terminal behavior is IDENTICAL to today.
//
// Critical invariants (from explore):
//   1. isSplitPane=false for single-pane: TerminalView keeps its display:none hide/show
//   2. Stable React keys: PaneSlot.id (UUID), never terminalId — avoids remount flicker
//   3. Fit on drag-END only: SplitHandle defers fit until pointer-up
//   4. MAX_PANE_COUNT = 4 enforced in paneLayoutStore
//   5. Focus: clicking a pane calls focusSlot → sessionStore.setActiveTerminal
//   6. a11y: role="region" + aria-label per pane; tabIndex for keyboard focus

import React, { useCallback, useRef } from "react";
import { usePaneLayoutStore } from "../../stores/paneLayoutStore";
import { useSessionStore } from "../../stores/sessionStore";
import { TerminalView } from "./TerminalView";
import { SplitHandle } from "./SplitHandle";
import type { SessionId } from "../../lib/types";

interface PaneSplitViewProps {
  sessionId: SessionId;
  onTerminalOpened?: (slotId: string, terminalId: string) => void;
}

export function PaneSplitView({ sessionId, onTerminalOpened }: PaneSplitViewProps) {
  const layout = usePaneLayoutStore((s) => s.layouts[sessionId]);
  const { focusSlot, setRatio, assignTerminal } = usePaneLayoutStore.getState();
  const { setActiveTerminal, sessions } = useSessionStore();

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
      setActiveTerminal(sessionId, realTerminalId);
      onTerminalOpened?.(slotId, realTerminalId);
    },
    [sessionId, assignTerminal, setActiveTerminal, onTerminalOpened],
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

  // No layout yet — render nothing (layout is created by TerminalTabs on first open)
  if (!layout) return null;

  const { slots, direction, focusedSlotId } = layout;
  const isMultiPane = slots.length > 1;
  const session = sessions.get(sessionId);

  // Single-pane: delegate entirely to TerminalView in its normal mode.
  // This ensures single-terminal behavior is IDENTICAL to today.
  if (!isMultiPane) {
    const slot = slots[0]!; // safe: slots.length >= 1 always (store invariant)
    const tab = session?.terminals.find(
      (t) => t.id === slot.terminalId || (slot.terminalId == null && t.id.startsWith("pending-")),
    );
    const isActive = slot.terminalId === session?.activeTerminalId;
    return (
      <TerminalView
        key={slot.id}
        sessionId={sessionId}
        terminalId={slot.terminalId}
        onTerminalOpened={(realId) => handleTerminalOpened(slot.id, realId)}
        active={isActive}
        isSplitPane={false}
        reactKey={tab?.reactKey ?? slot.id}
      />
    );
  }

  // Multi-pane: render split grid with handles
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
      {slots.map((slot, i) => {
        const isFocused = slot.id === focusedSlotId;
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
            >
              <TerminalView
                sessionId={sessionId}
                terminalId={slot.terminalId}
                onTerminalOpened={(realId) => handleTerminalOpened(slot.id, realId)}
                active={true}
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
