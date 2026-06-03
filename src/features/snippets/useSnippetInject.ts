// features/snippets/useSnippetInject.ts — Inject resolved snippet into terminal
//
// Mirrors runStartupCommands in useConnection.ts but for a single resolved
// command string. Key differences vs runStartupCommands:
//   1. Insert mode omits the trailing "\n" (Insert vs Execute).
//   2. Multi-line resolved commands are written as ONE write_terminal call
//      (not per-line split — the snippet is already fully resolved).
//   3. No polling for terminal readiness — caller already has terminalId.
//
// SECURITY: The resolved command is NEVER logged (may contain password-type values).

import { tauriInvoke } from "../../lib/tauri";

export type InjectionMode = "insert" | "execute";

/**
 * Inject a fully-resolved snippet string into the active terminal.
 *
 * @param sessionId    — target SSH session id
 * @param terminalId   — target terminal id (null/undefined = no-op guard)
 * @param resolved     — fully-resolved snippet text (vars already substituted)
 * @param mode         — "insert" (no newline) | "execute" (append \n)
 */
export async function injectSnippet(
  sessionId: string,
  terminalId: string | null | undefined,
  resolved: string,
  mode: InjectionMode,
): Promise<void> {
  // Guard: null/undefined terminalId = no active terminal, silent no-op
  if (!terminalId) return;

  const payload = mode === "execute" ? resolved + "\n" : resolved;
  // SECURITY: Never log `payload` — it may contain resolved password-type values.
  const data = Array.from(new TextEncoder().encode(payload));

  await tauriInvoke<void>("write_terminal", {
    sessionId,
    terminalId,
    data,
  });
}
