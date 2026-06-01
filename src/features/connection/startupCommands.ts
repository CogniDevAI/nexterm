// features/connection/startupCommands.ts — Pure helpers for startup command handling

/** Trim and filter blank lines from a raw startup commands list. */
export function normalizeStartupCommands(raw: string[]): string[] {
  return raw.map((s) => s.trim()).filter(Boolean);
}
