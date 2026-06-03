// conflictBatch.test.ts — TDD RED-first tests for sequential multi-file conflict resolution
//
// MAJOR-1 fix: handleUpload, handleDownload, handleLocalDrop, handleRemoteDrop previously
// spawned detached concurrent async IIFE per selected entry, all racing on a single
// shared conflictResolveRef — causing dialog clobbering, silent drops, and hangs.
//
// The fix: sequential for...of + await, identical to the existing handleOSDrop pattern.
// processTransfersSequentially is the extracted pure logic that all four handlers now use.

import { describe, it, expect, vi } from "vitest";
import { processTransfersSequentially } from "./conflictBatch";
import type { ConflictResolution } from "../../lib/types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeItems(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `file${i + 1}.txt`);
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe("processTransfersSequentially", () => {
  it("transfers a single file with no conflict", async () => {
    const transferred: string[] = [];
    const checkConflict = vi.fn().mockResolvedValue(null); // no conflict
    const resolveConflict = vi.fn();
    const transfer = vi.fn().mockImplementation(async (item: string) => {
      transferred.push(item);
    });

    await processTransfersSequentially(
      ["file1.txt"],
      checkConflict,
      resolveConflict,
      transfer,
    );

    expect(transferred).toEqual(["file1.txt"]);
    expect(resolveConflict).not.toHaveBeenCalled();
  });

  it("prompts once per file and transfers each conflicting file sequentially (never concurrently)", async () => {
    const items = makeItems(3);
    const dialogCallOrder: string[] = [];
    const transferOrder: string[] = [];

    // Each file has a conflict
    const checkConflict = vi.fn().mockImplementation(async (item: string) => ({
      fileName: item,
    }));

    // Resolve always returns "overwrite" — record which item was shown
    const resolveConflict = vi.fn().mockImplementation(
      async (info: { fileName: string }): Promise<ConflictResolution> => {
        dialogCallOrder.push(info.fileName);
        return "overwrite";
      },
    );

    const transfer = vi.fn().mockImplementation(async (item: string) => {
      transferOrder.push(item);
    });

    await processTransfersSequentially(items, checkConflict, resolveConflict, transfer);

    // All three files processed
    expect(dialogCallOrder).toEqual(["file1.txt", "file2.txt", "file3.txt"]);
    expect(transferOrder).toEqual(["file1.txt", "file2.txt", "file3.txt"]);
  });

  it("skip_all after first conflict skips remaining files without further prompts", async () => {
    const items = makeItems(4);
    const promptCount = { value: 0 };
    const transferred: string[] = [];

    const checkConflict = vi.fn().mockImplementation(async (item: string) => ({
      fileName: item,
    }));

    // First invocation returns "skip_all"; subsequent should NOT be called
    const resolveConflict = vi.fn().mockImplementation(
      async (_info: unknown): Promise<ConflictResolution> => {
        promptCount.value += 1;
        return "skip_all"; // choose Skip All on first conflict
      },
    );

    const transfer = vi.fn().mockImplementation(async (item: string) => {
      transferred.push(item);
    });

    await processTransfersSequentially(items, checkConflict, resolveConflict, transfer);

    // Only ONE prompt shown
    expect(promptCount.value).toBe(1);
    // No transfers happened (skip_all)
    expect(transferred).toEqual([]);
  });

  it("overwrite_all transfers all remaining files without further prompts", async () => {
    const items = makeItems(4);
    const promptCount = { value: 0 };
    const transferred: string[] = [];

    const checkConflict = vi.fn().mockImplementation(async (item: string) => ({
      fileName: item,
    }));

    const resolveConflict = vi.fn().mockImplementation(
      async (_info: unknown): Promise<ConflictResolution> => {
        promptCount.value += 1;
        return "overwrite_all"; // choose Overwrite All on first conflict
      },
    );

    const transfer = vi.fn().mockImplementation(async (item: string) => {
      transferred.push(item);
    });

    await processTransfersSequentially(items, checkConflict, resolveConflict, transfer);

    // Only ONE prompt shown
    expect(promptCount.value).toBe(1);
    // All 4 files transferred
    expect(transferred).toEqual(items);
  });

  it("skip on single file does not transfer it; other files are still processed", async () => {
    const items = ["a.txt", "b.txt", "c.txt"];
    const transferred: string[] = [];

    const checkConflict = vi.fn().mockImplementation(async (item: string) => ({
      fileName: item,
    }));

    // Skip a.txt, overwrite rest
    const resolveConflict = vi.fn().mockImplementation(
      async (info: { fileName: string }): Promise<ConflictResolution> => {
        return info.fileName === "a.txt" ? "skip" : "overwrite";
      },
    );

    const transfer = vi.fn().mockImplementation(async (item: string) => {
      transferred.push(item);
    });

    await processTransfersSequentially(items, checkConflict, resolveConflict, transfer);

    // a.txt skipped, b + c transferred
    expect(transferred).toEqual(["b.txt", "c.txt"]);
    // All three were prompted (no skip_all)
    expect(resolveConflict).toHaveBeenCalledTimes(3);
  });

  it("no file is silently dropped — every item is either transferred or skipped", async () => {
    const items = makeItems(5);
    const transferred: string[] = [];
    const skipped: string[] = [];

    const checkConflict = vi.fn().mockImplementation(async (item: string) => ({
      fileName: item,
    }));

    // Alternate skip / overwrite per file
    const resolveConflict = vi.fn().mockImplementation(
      async (info: { fileName: string }): Promise<ConflictResolution> => {
        const idx = items.indexOf(info.fileName);
        return idx % 2 === 0 ? "skip" : "overwrite";
      },
    );

    const transfer = vi.fn().mockImplementation(async (item: string) => {
      transferred.push(item);
    });

    await processTransfersSequentially(
      items,
      checkConflict,
      resolveConflict,
      transfer,
      { onSkip: (item) => skipped.push(item) },
    );

    expect(transferred.length + skipped.length).toBe(items.length);
    // No item appears in both
    const overlap = transferred.filter((t) => skipped.includes(t));
    expect(overlap).toHaveLength(0);
  });

  it("transfers files that have no conflict without prompting", async () => {
    const items = ["clean1.txt", "conflict.txt", "clean2.txt"];
    const prompted: string[] = [];
    const transferred: string[] = [];

    const checkConflict = vi.fn().mockImplementation(async (item: string) => {
      return item === "conflict.txt" ? { fileName: item } : null;
    });

    const resolveConflict = vi.fn().mockImplementation(
      async (info: { fileName: string }): Promise<ConflictResolution> => {
        prompted.push(info.fileName);
        return "overwrite";
      },
    );

    const transfer = vi.fn().mockImplementation(async (item: string) => {
      transferred.push(item);
    });

    await processTransfersSequentially(items, checkConflict, resolveConflict, transfer);

    expect(prompted).toEqual(["conflict.txt"]); // only one prompt
    expect(transferred).toEqual(items); // all three transferred
  });
});
