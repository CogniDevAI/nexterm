// batchConflictResolver.ts — Per-operation batch conflict decision tracker
//
// Owns the "batch short-circuit" state that allows a user to pick
// "Skip All" or "Overwrite All" and have subsequent files in the SAME
// transfer operation skip the dialog.
//
// Critical invariant: every new transfer operation MUST call beginOperation()
// before its first conflict check.  This nulls the internal decision so a
// stale choice from a prior operation can never leak into the next one.
//
// The component uses a single instance (via useRef) and calls:
//   resolver.beginOperation()  — at the top of every transfer entry-point
//   resolver.resolve(info, askDialog) — instead of the inline resolveConflict logic

import type { ConflictInfo, ConflictResolution } from "../../lib/types";

export interface BatchConflictResolver {
  /**
   * Reset the batch decision.  MUST be called at the start of each logical
   * transfer operation before any conflict check.
   */
  beginOperation(): void;

  /**
   * Resolve a conflict using the batch decision (if active) or by prompting
   * the user via askDialog.
   *
   * Returns "skip" or "overwrite" — the two actionable outcomes for callers
   * that use resolveConflict (single-file and folder download paths).
   * Returns the full ConflictResolution when called from processTransfersSequentially
   * via askConflict; callers that need skip_all/overwrite_all must use askDialog directly.
   */
  resolve(
    info: ConflictInfo,
    askDialog: (info: ConflictInfo) => Promise<ConflictResolution>,
  ): Promise<"skip" | "overwrite">;
}

/**
 * Create a BatchConflictResolver instance.
 *
 * Typically called once per component mount and held in a ref:
 *   const resolverRef = useRef(createBatchConflictResolver());
 */
export function createBatchConflictResolver(): BatchConflictResolver {
  let batchDecision: ConflictResolution | null = null;

  return {
    beginOperation() {
      batchDecision = null;
    },

    async resolve(
      info: ConflictInfo,
      askDialog: (info: ConflictInfo) => Promise<ConflictResolution>,
    ): Promise<"skip" | "overwrite"> {
      if (batchDecision === "skip_all") return "skip";
      if (batchDecision === "overwrite_all") return "overwrite";

      const resolution = await askDialog(info);

      // Persist batch decisions for subsequent files in the same operation.
      if (resolution === "skip_all" || resolution === "overwrite_all") {
        batchDecision = resolution;
      }

      if (resolution === "skip" || resolution === "skip_all") return "skip";
      return "overwrite";
    },
  };
}
