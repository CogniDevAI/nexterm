// stores/transferStore.ts — Zustand store for tracking active file transfers
//
// Manages transfer lifecycle: add, update progress, complete, fail, cancel.
// Used by TransferOverlay and useSftp hook.

import { create } from "zustand";
import { tauriInvoke } from "../lib/tauri";
import type { TransferId, TransferProgress } from "../lib/types";

interface TransferStoreState {
  transfers: Map<string, TransferProgress>;

  addTransfer: (transfer: TransferProgress) => void;
  updateProgress: (transferId: TransferId, bytesTransferred: number, totalBytes: number) => void;
  completeTransfer: (transferId: TransferId) => void;
  failTransfer: (transferId: TransferId, error: string) => void;
  cancelTransfer: (transferId: TransferId, sessionId: string) => Promise<void>;
  removeTransfer: (transferId: TransferId) => void;
  clearCompleted: () => void;

  // Derived
  activeCount: () => number;
  overallProgress: () => number;
}

export const useTransferStore = create<TransferStoreState>((set, get) => ({
  transfers: new Map(),

  addTransfer: (transfer) =>
    set((state) => {
      const next = new Map(state.transfers);
      next.set(transfer.id, transfer);
      return { transfers: next };
    }),

  updateProgress: (transferId, bytesTransferred, totalBytes) =>
    set((state) => {
      const existing = state.transfers.get(transferId);
      if (!existing) return state;
      const next = new Map(state.transfers);
      next.set(transferId, { ...existing, bytesTransferred, totalBytes });
      return { transfers: next };
    }),

  completeTransfer: (transferId) =>
    set((state) => {
      const existing = state.transfers.get(transferId);
      if (!existing) return state;
      const next = new Map(state.transfers);
      next.set(transferId, {
        ...existing,
        status: "completed",
        bytesTransferred: existing.totalBytes,
      });
      return { transfers: next };
    }),

  failTransfer: (transferId, error) =>
    set((state) => {
      const existing = state.transfers.get(transferId);
      if (!existing) return state;
      const next = new Map(state.transfers);
      next.set(transferId, { ...existing, status: "failed", error });
      return { transfers: next };
    }),

  cancelTransfer: async (transferId, sessionId) => {
    try {
      await tauriInvoke<void>("sftp_cancel_transfer", {
        sessionId,
        transferId,
      });
    } catch {
      // Transfer may have already completed
    }
    set((state) => {
      const existing = state.transfers.get(transferId);
      if (!existing) return state;
      const next = new Map(state.transfers);
      next.set(transferId, { ...existing, status: "cancelled" });
      return { transfers: next };
    });
  },

  removeTransfer: (transferId) =>
    set((state) => {
      const next = new Map(state.transfers);
      next.delete(transferId);
      return { transfers: next };
    }),

  clearCompleted: () =>
    set((state) => {
      const next = new Map(state.transfers);
      for (const [id, t] of next) {
        if (t.status === "completed" || t.status === "cancelled" || t.status === "failed") {
          next.delete(id);
        }
      }
      return { transfers: next };
    }),

  activeCount: () => {
    let count = 0;
    for (const t of get().transfers.values()) {
      if (t.status === "active") count++;
    }
    return count;
  },

  overallProgress: () => {
    let totalBytes = 0;
    let transferred = 0;
    for (const t of get().transfers.values()) {
      if (t.status === "active") {
        totalBytes += t.totalBytes;
        transferred += t.bytesTransferred;
      }
    }
    return totalBytes > 0 ? (transferred / totalBytes) * 100 : 0;
  },
}));
