// lib/types.ts — Shared TypeScript types mirroring Rust types
//
// All types use camelCase to match Rust's #[serde(rename_all = "camelCase")].
// These are the IPC contract types between frontend and backend.

// ─── ID Types ───────────────────────────────────────────

export type SessionId = string; // UUID
export type TerminalId = string; // UUID
export type TunnelId = string; // UUID
export type TransferId = string; // UUID

export type ActiveFeature = "terminal" | "sftp" | "tunnel";

// ─── User Credential (per-user auth within a profile) ───

export interface UserCredential {
  id: string;           // UUID
  username: string;
  authMethod: AuthMethodConfig;
  isDefault?: boolean;
}

// ─── Connection Profile ─────────────────────────────────

export interface ConnectionProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  users: UserCredential[];
  startupDirectory?: string;
  tunnels: TunnelConfig[];
  displayOrder?: number;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

export type AuthMethodConfig =
  | { type: "password" }
  | { type: "publicKey"; privateKeyPath: string; passphraseInKeychain: boolean }
  | { type: "keyboardInteractive" };

// ─── Session State ──────────────────────────────────────

export type SessionState =
  | "disconnected"
  | "connecting"
  | "authenticating"
  | "connected"
  | { error: { message: string } };

export interface SessionInfo {
  id: SessionId;
  profileName: string;
  host: string;
  userId: string;
  username: string;
  state: SessionState;
  terminalCount: number;
  hasSftp: boolean;
  tunnelCount: number;
}

// ─── File Entry ─────────────────────────────────────────

export interface FileEntry {
  name: string;
  path: string;
  fileType: FileType;
  size: number;
  permissions: number;
  permissionsStr: string;
  modified: number | null; // Unix timestamp
  accessed: number | null;
  owner: number | null; // UID
  group: number | null; // GID
  /** For symlinks: the type of the target. Absent for non-symlink entries. */
  linkTarget?: "directory" | "file" | "broken" | null;
}

export type FileType = "file" | "directory" | "symlink" | "other";

// ─── Tunnel ─────────────────────────────────────────────

export interface TunnelConfig {
  id: TunnelId;
  tunnelType: TunnelType;
  bindHost: string;
  bindPort: number;
  targetHost: string;
  targetPort: number;
  label?: string;
}

export type TunnelType = "local" | "remote";

export type TunnelState =
  | "stopped"
  | "starting"
  | { active: { connections: number } }
  | { error: { message: string } };

export interface TunnelInfo {
  config: TunnelConfig;
  state: TunnelState;
  bytesIn: number;
  bytesOut: number;
  activeConnections: number;
}

// ─── Transfer ───────────────────────────────────────────

export type TransferDirection = "upload" | "download";

export interface TransferProgress {
  id: TransferId;
  fileName: string;
  direction: TransferDirection;
  totalBytes: number;
  bytesTransferred: number;
  status: "active" | "completed" | "failed" | "cancelled";
  error?: string;
}

// ─── Streaming Events ───────────────────────────────────

export type TerminalEvent =
  | { event: "output"; data: { data: number[] } }
  | { event: "closed"; data: { reason: string } }
  | { event: "error"; data: { message: string } };

export type TransferEvent =
  | {
      event: "started";
      data: {
        transferId: string;
        fileName: string;
        totalBytes: number;
        direction: TransferDirection;
      };
    }
  | {
      event: "progress";
      data: {
        transferId: string;
        bytesTransferred: number;
        totalBytes: number;
      };
    }
  | { event: "completed"; data: { transferId: string } }
  | { event: "failed"; data: { transferId: string; error: string } };

export type TunnelEvent =
  | {
      event: "stateChanged";
      data: { tunnelId: string; state: TunnelState };
    }
  | {
      event: "traffic";
      data: { tunnelId: string; bytesIn: number; bytesOut: number };
    };

// ─── Host Key Verification ──────────────────────────────

export type HostKeyStatus =
  | { type: "trusted" }
  | { type: "unknown"; fingerprint: string; keyType: string }
  | {
      type: "changed";
      oldFingerprint: string;
      newFingerprint: string;
      keyType: string;
      /** Set when the stored key used a different algorithm (e.g. ssh-rsa).
       *  Absent when the key type is the same (genuine fingerprint change). */
      oldKeyType?: string;
    }
  | { type: "revoked" };

export interface HostKeyVerificationRequest {
  host: string;
  port: number;
  status: HostKeyStatus;
  /** Session ID injected by the Rust connect command so the frontend can
   *  respond without waiting for the connect promise to resolve. */
  sessionId?: string;
}

export type HostKeyVerificationResponse =
  | "accept"
  | "acceptAndSave"
  | "reject";

// ─── Search Result (SFTP recursive search) ──────────

export interface SearchResult {
  path: string;          // full absolute path on remote
  fileName: string;      // just the name
  fileType: string;      // "file" or "directory"
  size: number;
  relativePath: string;  // path relative to search base_path
}

// ─── File Content (SFTP file viewer) ────────────────

export interface FileContent {
  content: string;
  fileName: string;
  fileSize: number;
  encoding: string;
  truncated: boolean;
  totalLines: number;
}
