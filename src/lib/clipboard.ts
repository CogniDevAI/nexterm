// lib/clipboard.ts — Clipboard helpers with secret auto-clear
//
// Two entry points:
//   - copyText(text)            normal copy, no expiry
//   - copySecret(text, opts?)   copy, then auto-clear after a timeout
//
// Why this exists: copied secrets (passwords, private keys, tokens) otherwise
// linger in the system clipboard forever, where any app or paste target can
// read them. copySecret schedules a best-effort clear so the secret does not
// outlive its usefulness.
//
// Mechanism: the app does not bundle @tauri-apps/plugin-clipboard-manager, so
// every existing copy site uses the Web Clipboard API (navigator.clipboard).
// We do the same here to stay consistent. readText is used (when available) to
// guard the clear: we only overwrite the clipboard if it STILL holds the
// secret, so we never wipe something the user copied afterwards.

import { SECRET_CLIPBOARD_CLEAR_MS } from "./constants";

// ─── Options ──────────────────────────────────────────────

export interface CopySecretOptions {
  /** Milliseconds before the clipboard is auto-cleared. */
  timeoutMs?: number;
}

/** Cancels a pending secret clear. Safe to call multiple times. */
export type CancelSecretClear = () => void;

// ─── Internal clipboard access ────────────────────────────
//
// Resolved lazily on each call so a clipboard mock installed by tests (or a
// clipboard that only becomes available after a user gesture) is respected.

function getClipboard(): Clipboard | undefined {
  if (typeof navigator === "undefined") return undefined;
  return navigator.clipboard;
}

async function writeClipboard(text: string): Promise<void> {
  const clipboard = getClipboard();
  if (!clipboard) return;
  await clipboard.writeText(text);
}

async function readClipboard(): Promise<string | null> {
  const clipboard = getClipboard();
  if (!clipboard || typeof clipboard.readText !== "function") return null;
  try {
    return await clipboard.readText();
  } catch {
    // readText can reject (permissions, focus). Fall back to an unconditional
    // clear by signalling "unknown".
    return null;
  }
}

// ─── Pending clear (module-global) ────────────────────────
//
// Only one secret-clear timer is meaningful at a time: a newer secret copy
// supersedes the older one. We track the active timer so a new copySecret —
// or an explicit cancelSecretClear — can cancel the previous one.

let pendingTimer: ReturnType<typeof setTimeout> | null = null;

function clearPendingTimer(): void {
  if (pendingTimer !== null) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
}

/** Cancels any pending secret clear scheduled by copySecret. */
export function cancelSecretClear(): void {
  clearPendingTimer();
}

// ─── Public API ───────────────────────────────────────────

/** Copies plain (non-secret) text to the clipboard. No auto-clear. */
export async function copyText(text: string): Promise<void> {
  await writeClipboard(text);
}

/**
 * Copies a secret to the clipboard, then schedules a best-effort clear after
 * `timeoutMs` (default SECRET_CLIPBOARD_CLEAR_MS).
 *
 * The clear only fires if the clipboard STILL holds this secret — if the user
 * copied something else in the meantime, that newer value is left untouched.
 * When the clipboard cannot be read (no readText / permission denied), the
 * clear still happens unconditionally, which is the safe default for a secret.
 *
 * Returns a cancel function; calling it prevents the pending clear.
 */
export async function copySecret(
  text: string,
  opts?: CopySecretOptions,
): Promise<CancelSecretClear> {
  // A new secret copy supersedes any previously scheduled clear.
  clearPendingTimer();

  await writeClipboard(text);

  const timeoutMs = opts?.timeoutMs ?? SECRET_CLIPBOARD_CLEAR_MS;

  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    void (async () => {
      const current = await readClipboard();
      // Only clear when we positively know the secret is still there, or when
      // we cannot read at all (null → clear to be safe). If the clipboard now
      // holds a different value, leave it alone.
      if (current === null || current === text) {
        await writeClipboard("");
      }
    })();
  }, timeoutMs);

  return cancelSecretClear;
}
