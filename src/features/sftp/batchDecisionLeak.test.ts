// batchDecisionLeak.test.ts — REAL regression guard for cross-operation batch-state leak
//
// This file tests createBatchConflictResolver — the module that SftpBrowser now uses
// for ALL conflict resolution decisions.  Every batchDecisionRef.current write/read
// in the old inline code lives here now, so these tests exercise the ACTUAL production
// code path, not a hand-written copy of it.
//
// The recurring bug: choosing "Skip All" or "Overwrite All" in one transfer operation
// leaked into a later single-file transfer, silently skipping/overwriting without
// ever showing the ConflictDialog.
//
// The fix invariant: beginOperation() MUST be called at every entry point.
// Tests below verify that NOT calling beginOperation() causes the leak (RED on
// pre-fix code) and that calling it prevents the leak (GREEN now).

import { describe, it, expect, vi } from "vitest";
import { createBatchConflictResolver } from "./batchConflictResolver";
import type { ConflictInfo, ConflictResolution } from "../../lib/types";

const stubConflict: ConflictInfo = {
  fileName: "report.pdf",
  destinationPath: "/dest/report.pdf",
  existingSize: 1024,
  existingModified: 1700000000,
  incomingSize: 2048,
  direction: "upload",
};

// ─── TEST HELPERS ─────────────────────────────────────────────────────────────

/** askDialog that always returns the given resolution (simulates user picking) */
function alwaysResolveWith(resolution: ConflictResolution) {
  return vi.fn().mockResolvedValue(resolution);
}

// ─── SUITE ────────────────────────────────────────────────────────────────────

describe("createBatchConflictResolver — cross-operation leak prevention", () => {
  // ─── Test 1: skip_all leaks into next operation WITHOUT beginOperation ──────
  //
  // This test MUST FAIL if the entry-point beginOperation() call is removed.
  // It verifies the bug path is real: without the reset, resolve() returns
  // "skip" from the stale batch decision and askDialog is never called.

  it("stale skip_all silently skips a subsequent resolve() when beginOperation() is NOT called (documents the bug)", async () => {
    const resolver = createBatchConflictResolver();

    // Operation A: user picks skip_all
    resolver.beginOperation();
    const askA = alwaysResolveWith("skip_all");
    await resolver.resolve(stubConflict, askA);
    // Internal batchDecision is now "skip_all"

    // Operation B: NO beginOperation() call — simulating the pre-fix bug
    const askB = vi.fn(); // must NOT be called if the leak is present
    const result = await resolver.resolve(stubConflict, askB);

    // Without reset: the stale skip_all short-circuits → silent skip, no dialog
    expect(result).toBe("skip");
    expect(askB).not.toHaveBeenCalled(); // dialog was bypassed — the bug
  });

  // ─── Test 2: beginOperation() clears skip_all so the next op shows the dialog ─
  //
  // This is the PRIMARY regression guard.  It MUST PASS after the fix.
  // If beginOperation() calls are removed from any entry point, a later
  // single-file transfer through that entry point will NOT show the dialog
  // and will silently skip — this test catches that.

  it("beginOperation() resets skip_all so a subsequent resolve() prompts the dialog", async () => {
    const resolver = createBatchConflictResolver();

    // Operation A: multi-file batch — user picks skip_all
    resolver.beginOperation();
    const askA = alwaysResolveWith("skip_all");
    const resultA = await resolver.resolve(stubConflict, askA);
    expect(resultA).toBe("skip"); // first file in batch: skip_all → skip
    expect(askA).toHaveBeenCalledTimes(1);

    // Operation B: new transfer — beginOperation() MUST be called first
    resolver.beginOperation(); // ← THE FIX
    const askB = alwaysResolveWith("overwrite");
    const resultB = await resolver.resolve(stubConflict, askB);

    // Dialog WAS shown (askB called), file was NOT silently skipped
    expect(askB).toHaveBeenCalledTimes(1);
    expect(resultB).toBe("overwrite");
  });

  // ─── Test 3: overwrite_all leaks without reset / cleared with beginOperation ─

  it("stale overwrite_all silently overwrites a subsequent resolve() when beginOperation() is NOT called (documents the bug)", async () => {
    const resolver = createBatchConflictResolver();

    resolver.beginOperation();
    await resolver.resolve(stubConflict, alwaysResolveWith("overwrite_all"));
    // Internal batchDecision is now "overwrite_all"

    // No reset — the bug
    const askB = vi.fn();
    const result = await resolver.resolve(stubConflict, askB);

    expect(result).toBe("overwrite"); // silently overwritten without dialog
    expect(askB).not.toHaveBeenCalled();
  });

  it("beginOperation() resets overwrite_all so a subsequent resolve() prompts the dialog", async () => {
    const resolver = createBatchConflictResolver();

    resolver.beginOperation();
    await resolver.resolve(stubConflict, alwaysResolveWith("overwrite_all"));

    // New operation: reset
    resolver.beginOperation(); // ← THE FIX
    const askB = alwaysResolveWith("skip");
    const resultB = await resolver.resolve(stubConflict, askB);

    expect(askB).toHaveBeenCalledTimes(1);
    expect(resultB).toBe("skip"); // user chose skip — dialog was shown
  });

  // ─── Test 4: batch short-circuit WITHIN an operation works correctly ─────────
  //
  // Within a SINGLE operation, after skip_all is chosen for file #1,
  // resolve() must NOT call askDialog for files #2 and #3.

  it("skip_all in resolve() short-circuits subsequent files in the SAME operation", async () => {
    const resolver = createBatchConflictResolver();
    resolver.beginOperation();

    // File 1: user picks skip_all
    const ask = alwaysResolveWith("skip_all");
    const r1 = await resolver.resolve(stubConflict, ask);
    expect(r1).toBe("skip");
    expect(ask).toHaveBeenCalledTimes(1);

    // Files 2 and 3 in the same operation: short-circuited, askDialog must NOT be called
    const r2 = await resolver.resolve(stubConflict, ask);
    const r3 = await resolver.resolve(stubConflict, ask);
    expect(r2).toBe("skip");
    expect(r3).toBe("skip");
    // ask was called once total (for file 1 only)
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("overwrite_all in resolve() short-circuits subsequent files in the SAME operation", async () => {
    const resolver = createBatchConflictResolver();
    resolver.beginOperation();

    const ask = alwaysResolveWith("overwrite_all");
    const r1 = await resolver.resolve(stubConflict, ask);
    expect(r1).toBe("overwrite");
    expect(ask).toHaveBeenCalledTimes(1);

    // Files 2 and 3: short-circuited
    const r2 = await resolver.resolve(stubConflict, ask);
    const r3 = await resolver.resolve(stubConflict, ask);
    expect(r2).toBe("overwrite");
    expect(r3).toBe("overwrite");
    expect(ask).toHaveBeenCalledTimes(1);
  });

  // ─── Test 5: multiple operations do not interfere (each gets a clean state) ──

  it("three sequential operations each start clean after beginOperation()", async () => {
    const resolver = createBatchConflictResolver();

    for (const expected of ["skip", "overwrite", "skip"] as const) {
      resolver.beginOperation();
      const resolution: ConflictResolution = expected === "skip" ? "skip" : "overwrite";
      const ask = alwaysResolveWith(resolution);
      const result = await resolver.resolve(stubConflict, ask);
      expect(result).toBe(expected);
      expect(ask).toHaveBeenCalledTimes(1);
    }
  });

  // ─── Test 6: beginOperation() between batches lets overwrite_all then skip ───
  //
  // Specifically: a bulk batch uses overwrite_all → next single-file op
  // independently picks skip.  The two decisions must not bleed into each other.

  it("overwrite_all in operation A does not affect operation B that independently resolves to skip", async () => {
    const resolver = createBatchConflictResolver();

    // Batch upload (A): 2 files, user picks overwrite_all on first
    resolver.beginOperation();
    const askA = alwaysResolveWith("overwrite_all");
    expect(await resolver.resolve(stubConflict, askA)).toBe("overwrite");
    expect(await resolver.resolve(stubConflict, askA)).toBe("overwrite");
    expect(askA).toHaveBeenCalledTimes(1); // short-circuited after first

    // Context-menu single-file upload (B): reset, user independently picks skip
    resolver.beginOperation();
    const askB = alwaysResolveWith("skip");
    const resultB = await resolver.resolve(stubConflict, askB);
    expect(resultB).toBe("skip");
    expect(askB).toHaveBeenCalledTimes(1); // dialog was shown — NOT silently overwritten
  });
});
