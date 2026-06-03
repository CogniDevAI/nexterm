// features/snippets/resolveSessionVars.ts — Dynamic built-in variable resolution
//
// Resolves HOST / USERNAME / PORT / SESSION_ID from the active SessionEntry.
// These vars are pre-filled into the values map BEFORE the SnippetVariableModal
// so they never appear as user-facing input fields.
//
// If no active session exists, all vars resolve to empty string (safe no-crash fallback).

import type { SessionEntry } from "../../stores/sessionStore";

/** Names of built-in dynamic variables that are resolved from the active session. */
export const DYNAMIC_VAR_NAMES = ["HOST", "USERNAME", "PORT", "SESSION_ID"] as const;

export type DynamicVarName = (typeof DYNAMIC_VAR_NAMES)[number];

/**
 * Build a values map pre-seeded with dynamic built-in variables from the session.
 *
 * @param session — the active SessionEntry, or null/undefined for no-session fallback
 * @returns Record<string, string> — can be spread into the user-supplied values map
 */
export function resolveSessionVars(
  session: SessionEntry | null | undefined,
): Record<DynamicVarName, string> {
  if (!session) {
    return {
      HOST: "",
      USERNAME: "",
      PORT: "",
      SESSION_ID: "",
    };
  }

  return {
    HOST: session.host,
    USERNAME: session.username,
    PORT: String(session.port),
    SESSION_ID: session.id,
  };
}
