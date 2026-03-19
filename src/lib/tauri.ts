// lib/tauri.ts — Typed Tauri invoke wrapper and error handling
//
// All IPC calls to the Rust backend should go through tauriInvoke<T>()
// for consistent error handling and type safety.

import { invoke } from "@tauri-apps/api/core";

// ─── AppError ───────────────────────────────────────────

export class AppError extends Error {
  public readonly command: string;

  constructor(command: string, message: string) {
    super(message);
    this.name = "AppError";
    this.command = command;
  }

  get isAuthFailed(): boolean {
    return this.message.includes("Authentication failed");
  }

  get isNotConnected(): boolean {
    return this.message.includes("Not connected");
  }

  get isTimeout(): boolean {
    return this.message.includes("timeout");
  }

  get isSessionNotFound(): boolean {
    return this.message.includes("Session not found");
  }

  get isHostKeyRejected(): boolean {
    return this.message.includes("Host key verification failed");
  }

  get isKeyError(): boolean {
    return this.message.includes("Key error");
  }

  get isKeychainError(): boolean {
    return this.message.includes("Keychain error");
  }

  get isVaultLocked(): boolean {
    return this.message.includes("Vault is locked");
  }

  get isVaultError(): boolean {
    return this.message.includes("Vault error");
  }

  get isPermissionDenied(): boolean {
    return this.message.includes("Permission denied");
  }
}

// ─── Typed Invoke Wrapper ───────────────────────────────

export async function tauriInvoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (error) {
    throw new AppError(cmd, error as string);
  }
}
