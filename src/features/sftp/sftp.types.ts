// features/sftp/sftp.types.ts — SFTP-specific frontend types

import type { FileEntry } from "../../lib/types";

export type PaneSource = "local" | "remote";

export type SortField = "name" | "size" | "modified" | "permissions";
export type SortDirection = "asc" | "desc";

export interface SortConfig {
  field: SortField;
  direction: SortDirection;
}

export interface PaneState {
  path: string;
  entries: FileEntry[];
  loading: boolean;
  error: string | null;
  history: string[];
  historyIndex: number;
}

export interface FileAction {
  type: "download" | "upload" | "rename" | "delete" | "newFolder" | "refresh" | "copyPath" | "open" | "openWith" | "openExternal" | "saveAsAndOpen";
  entry?: FileEntry;
}
