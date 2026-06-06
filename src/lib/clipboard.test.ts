// lib/clipboard.test.ts — TDD: clipboard helpers with secret auto-clear
//
// Written BEFORE the implementation (RED phase).
//
// The clipboard layer (navigator.clipboard) is mocked so we can assert
// exactly what gets written and when. Fake timers let us advance past the
// auto-clear timeout deterministically.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { copyText, copySecret, cancelSecretClear } from "./clipboard";
import { SECRET_CLIPBOARD_CLEAR_MS } from "./constants";

// ─── Clipboard mock ───────────────────────────────────────
//
// A tiny stateful stub: writeText stores the value, readText returns it.
// This lets us prove the "only clear if it still holds the secret" guard.

let clipboardValue = "";
const writeText = vi.fn(async (text: string) => {
  clipboardValue = text;
});
const readText = vi.fn(async () => clipboardValue);

beforeEach(() => {
  clipboardValue = "";
  writeText.mockClear();
  readText.mockClear();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText, readText },
  });
  vi.useFakeTimers();
});

afterEach(() => {
  cancelSecretClear();
  vi.useRealTimers();
});

describe("copyText", () => {
  it("writes the value to the clipboard", async () => {
    await copyText("plain value");
    expect(writeText).toHaveBeenCalledWith("plain value");
    expect(clipboardValue).toBe("plain value");
  });

  it("does NOT schedule any clear", async () => {
    await copyText("plain value");
    writeText.mockClear();
    await vi.advanceTimersByTimeAsync(SECRET_CLIPBOARD_CLEAR_MS + 1000);
    expect(writeText).not.toHaveBeenCalled();
    expect(clipboardValue).toBe("plain value");
  });
});

describe("copySecret", () => {
  it("writes the secret value immediately", async () => {
    await copySecret("super-secret");
    expect(writeText).toHaveBeenCalledWith("super-secret");
    expect(clipboardValue).toBe("super-secret");
  });

  it("clears the clipboard after the default timeout", async () => {
    await copySecret("super-secret");
    expect(clipboardValue).toBe("super-secret");

    await vi.advanceTimersByTimeAsync(SECRET_CLIPBOARD_CLEAR_MS);

    expect(writeText).toHaveBeenLastCalledWith("");
    expect(clipboardValue).toBe("");
  });

  it("honours a custom timeout from opts", async () => {
    await copySecret("super-secret", { timeoutMs: 5000 });

    await vi.advanceTimersByTimeAsync(4999);
    expect(clipboardValue).toBe("super-secret");

    await vi.advanceTimersByTimeAsync(1);
    expect(clipboardValue).toBe("");
  });

  it("does NOT clear if the user copied something else afterwards", async () => {
    await copySecret("super-secret");
    // Simulate the user copying a different value before the timeout fires.
    clipboardValue = "user copied this later";

    await vi.advanceTimersByTimeAsync(SECRET_CLIPBOARD_CLEAR_MS);

    // The guard must leave the newer value untouched.
    expect(clipboardValue).toBe("user copied this later");
    expect(writeText).not.toHaveBeenLastCalledWith("");
  });

  it("returns a cancel function that prevents the clear", async () => {
    const cancel = await copySecret("super-secret");
    cancel();

    await vi.advanceTimersByTimeAsync(SECRET_CLIPBOARD_CLEAR_MS + 1000);

    expect(clipboardValue).toBe("super-secret");
    expect(writeText).not.toHaveBeenLastCalledWith("");
  });
});

describe("cancelSecretClear", () => {
  it("cancels a pending clear globally", async () => {
    await copySecret("super-secret");
    cancelSecretClear();

    await vi.advanceTimersByTimeAsync(SECRET_CLIPBOARD_CLEAR_MS + 1000);

    expect(clipboardValue).toBe("super-secret");
  });

  it("scheduling a new secret cancels the previous pending clear", async () => {
    await copySecret("first-secret", { timeoutMs: 10_000 });
    // Halfway through, copy a second secret with its own timer.
    await vi.advanceTimersByTimeAsync(5000);
    await copySecret("second-secret", { timeoutMs: 10_000 });

    // The first timer's original deadline passes; it must NOT clear the
    // second secret.
    await vi.advanceTimersByTimeAsync(5000);
    expect(clipboardValue).toBe("second-secret");

    // The second timer completes and clears.
    await vi.advanceTimersByTimeAsync(5000);
    expect(clipboardValue).toBe("");
  });
});
