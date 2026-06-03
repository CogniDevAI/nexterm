// conflictBatch.ts — Sequential multi-file conflict resolution loop
//
// Extracted from SftpBrowser so the logic is independently testable and
// reused by handleUpload, handleDownload, handleLocalDrop, handleRemoteDrop.
//
// Key invariants:
//   - One entry processed at a time → the shared conflict dialog ref is never
//     contended by concurrent callers.
//   - batchDecision (skip_all / overwrite_all) is applied inline, short-circuiting
//     the remaining files without additional dialog prompts.
//   - Every selected entry is accounted for: either transferred, skipped, or
//     reported via onSkip/onError — nothing is silently dropped.

import type { ConflictResolution } from "../../lib/types";

export interface TransferCallbacks<T> {
  /** Called for each item that is skipped (conflict → skip / skip_all). */
  onSkip?: (item: T) => void;
  /** Called for each item that throws during transfer. Default: swallow error. */
  onError?: (item: T, err: unknown) => void;
}

/**
 * Process a list of items sequentially, checking for conflicts and asking the
 * user to resolve them one by one.  Batch decisions (skip_all / overwrite_all)
 * short-circuit remaining prompts.
 *
 * @param items           — ordered list of items to transfer.
 * @param checkConflict   — returns conflict info if a conflict exists, null otherwise.
 * @param resolveConflict — shows the dialog and returns the user's choice.
 *                          Will NOT be called if a batch decision is already active.
 * @param transfer        — performs the actual transfer for a single item.
 * @param callbacks       — optional lifecycle hooks (onSkip, onError).
 */
export async function processTransfersSequentially<T>(
  items: T[],
  checkConflict: (item: T) => Promise<object | null>,
  resolveConflict: (info: object) => Promise<ConflictResolution>,
  transfer: (item: T) => Promise<void>,
  callbacks: TransferCallbacks<T> = {},
): Promise<void> {
  let batchDecision: ConflictResolution | null = null;

  for (const item of items) {
    try {
      // Batch short-circuit: if the user already chose skip_all, skip immediately.
      if (batchDecision === "skip_all") {
        callbacks.onSkip?.(item);
        continue;
      }

      const conflictInfo = await checkConflict(item);

      if (conflictInfo !== null) {
        // Batch short-circuit: overwrite_all — no dialog needed.
        if (batchDecision === "overwrite_all") {
          await transfer(item);
          continue;
        }

        const decision = await resolveConflict(conflictInfo);

        // Persist batch decisions for subsequent items.
        if (decision === "skip_all" || decision === "overwrite_all") {
          batchDecision = decision;
        }

        if (decision === "skip" || decision === "skip_all") {
          callbacks.onSkip?.(item);
          continue;
        }
      }

      await transfer(item);
    } catch (err) {
      if (callbacks.onError) {
        callbacks.onError(item, err);
      }
      // If no onError handler, swallow so one failure doesn't block the rest.
    }
  }
}
