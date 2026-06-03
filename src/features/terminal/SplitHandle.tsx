// features/terminal/SplitHandle.tsx — Draggable resize handle between split panes
//
// Design constraints (from explore):
//   - During drag: update flex sizing via CSS only (data-ratio on parent pane)
//   - Call fit ONCE on pointer-up, not on every pointer-move
//   - The existing per-container ResizeObserver (RESIZE_DEBOUNCE_MS=100ms)
//     handles add/close re-fit automatically

import { useCallback, useRef } from "react";
import type { PaneDirection } from "../../stores/paneLayoutStore";

interface SplitHandleProps {
  direction: PaneDirection;
  onDragEnd: (deltaFraction: number) => void;
  /** Total pixel size of the split container (width for horizontal, height for vertical) */
  containerSize: number;
}

export function SplitHandle({ direction, onDragEnd, containerSize }: SplitHandleProps) {
  const startPosRef = useRef<number>(0);
  const draggingRef = useRef(false);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      draggingRef.current = true;
      startPosRef.current = direction === "horizontal" ? e.clientX : e.clientY;
    },
    [direction],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      // No-op during move: CSS flex handles visual update via ratio changes
      // deferred to pointer-up to avoid ResizeObserver/fit churn
      e.preventDefault();
    },
    [],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      e.currentTarget.releasePointerCapture(e.pointerId);

      const endPos = direction === "horizontal" ? e.clientX : e.clientY;
      const delta = endPos - startPosRef.current;
      const deltaFraction = containerSize > 0 ? delta / containerSize : 0;
      onDragEnd(deltaFraction);
    },
    [direction, containerSize, onDragEnd],
  );

  return (
    <div
      className="terminal-split-handle"
      role="separator"
      aria-orientation={direction === "horizontal" ? "vertical" : "horizontal"}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    />
  );
}
