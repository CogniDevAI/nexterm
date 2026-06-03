// features/terminal/broadcastUtils.ts — Pure broadcast fan-out utility
//
// Clean-room design. No store imports — takes already-resolved values as args.
// Fully testable in pure Node with no DOM or React required.

import type { PaneSlot } from "../../stores/paneLayoutStore";
import type { SessionState, TerminalId } from "../../lib/types";

/**
 * Computes the set of target terminalIds for a broadcast write.
 *
 * Rules:
 * - Session must be "connected" (string equality — not an object error state).
 * - Excludes the source terminalId (no double-write).
 * - Excludes slots with null terminalId (pending/not-yet-opened).
 * - Excludes slots whose terminalId starts with "pending-" (race: assigned but not real yet).
 *
 * @param slots            All slots in the current layout.
 * @param sourceTerminalId The terminalId that produced the keystroke (must be excluded).
 * @param sessionState     The session's current connection state.
 * @returns Array of target terminalIds (may be empty — caller handles empty gracefully).
 */
export function getBroadcastTargets(
  slots: PaneSlot[],
  sourceTerminalId: TerminalId,
  sessionState: SessionState,
): TerminalId[] {
  if (sessionState !== "connected") return [];
  return slots
    .filter(
      (s): s is PaneSlot & { terminalId: TerminalId } =>
        s.terminalId !== null &&
        s.terminalId !== sourceTerminalId &&
        !s.terminalId.startsWith("pending-"),
    )
    .map((s) => s.terminalId);
}
