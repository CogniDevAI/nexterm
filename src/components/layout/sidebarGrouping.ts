// sidebarGrouping.ts — Folder-first profile grouping for the Sidebar
//
// Approach 1 (spec): profile.folder takes priority; deriveGroup is the fallback.
// GroupKey is a plain string — user-defined folder names are verbatim; legacy
// heuristic keys ("production", "staging", etc.) are a subset of that string space.

import type { ConnectionProfile } from "../../lib/types";

// ─── Legacy heuristic group keys ──────────────────────────────────────────────
// These are the fixed i18n-backed keys produced by deriveGroup.

export type LegacyGroupKey = "production" | "development" | "certification" | "staging" | "other";

// Stable display order for legacy heuristic groups (shown AFTER user folders).
const LEGACY_GROUP_ORDER: LegacyGroupKey[] = [
  "production",
  "staging",
  "certification",
  "development",
  "other",
];

// ─── Profile group ────────────────────────────────────────────────────────────

export interface ProfileGroup {
  key: string;
  profiles: ConnectionProfile[];
}

// ─── deriveGroup ──────────────────────────────────────────────────────────────
// Pure heuristic: maps profile name to one of the five legacy group keys.
// Used ONLY as a fallback when profile.folder is absent or empty.

export function deriveGroup(profile: ConnectionProfile): LegacyGroupKey {
  const name = profile.name.toLowerCase();
  if (/\b(prod|production|prd)\b/.test(name)) return "production";
  if (/\b(dev|develop|development)\b/.test(name)) return "development";
  if (/\b(cert|cer|qa|test|tst)\b/.test(name)) return "certification";
  if (/\b(stag|staging|uat|pre\-?prod)\b/.test(name)) return "staging";
  return "other";
}

// ─── groupProfiles ────────────────────────────────────────────────────────────
// Groups profiles by folder (when set) or by deriveGroup (when absent).
//
// Ordering:
//   1. User-assigned folders (in insertion/encounter order, stable)
//   2. Legacy heuristic groups (in LEGACY_GROUP_ORDER, stable)
//
// Only groups that contain at least one profile are emitted.

export function groupProfiles(profiles: ConnectionProfile[]): ProfileGroup[] {
  // Collect user-assigned folder names in encounter order (stable)
  const userFolderOrder: string[] = [];
  const userFolderMap = new Map<string, ConnectionProfile[]>();

  // Collect legacy heuristic groups
  const legacyMap = new Map<LegacyGroupKey, ConnectionProfile[]>();
  for (const key of LEGACY_GROUP_ORDER) legacyMap.set(key, []);

  for (const profile of profiles) {
    const folder = profile.folder?.trim();
    if (folder) {
      // User-assigned folder
      if (!userFolderMap.has(folder)) {
        userFolderOrder.push(folder);
        userFolderMap.set(folder, []);
      }
      userFolderMap.get(folder)!.push(profile);
    } else {
      // Fall back to heuristic
      const key = deriveGroup(profile);
      legacyMap.get(key)!.push(profile);
    }
  }

  const result: ProfileGroup[] = [];

  // 1. User-assigned folders first
  for (const folder of userFolderOrder) {
    const folderProfiles = userFolderMap.get(folder)!;
    if (folderProfiles.length > 0) {
      result.push({ key: folder, profiles: folderProfiles });
    }
  }

  // 2. Legacy heuristic groups (only non-empty ones, in stable order)
  for (const key of LEGACY_GROUP_ORDER) {
    const keyProfiles = legacyMap.get(key)!;
    if (keyProfiles.length > 0) {
      result.push({ key, profiles: keyProfiles });
    }
  }

  return result;
}

// ─── Type guard ───────────────────────────────────────────────────────────────
// Returns true when a group key is one of the five legacy heuristic keys.
// Used by GroupHeader to decide whether to look up an i18n key or render verbatim.

export function isLegacyGroupKey(key: string): key is LegacyGroupKey {
  return (LEGACY_GROUP_ORDER as string[]).includes(key);
}
