// stores/profileStore.ts — Zustand store for connection profiles CRUD
//
// Actions call Tauri backend commands via tauriInvoke wrapper.

import { create } from "zustand";
import type { ConnectionProfile } from "../lib/types";
import { tauriInvoke } from "../lib/tauri";

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

interface ProfileStoreState {
  profiles: ConnectionProfile[];
  loading: boolean;
  error: string | null;

  loadProfiles: () => Promise<void>;
  saveProfile: (profile: ConnectionProfile) => Promise<string>;
  deleteProfile: (id: string) => Promise<void>;
  storeCredential: (profileId: string, password: string) => Promise<void>;
  exportProfiles: (exportPath: string, includeCredentials: boolean, exportPassword?: string) => Promise<number>;
  importProfiles: (importPath: string, importPassword?: string) => Promise<ImportResult>;
  clearError: () => void;
}

export const useProfileStore = create<ProfileStoreState>((set) => ({
  profiles: [],
  loading: false,
  error: null,

  loadProfiles: async () => {
    set({ loading: true, error: null });
    try {
      const profiles =
        await tauriInvoke<ConnectionProfile[]>("load_profiles");
      set({ profiles, loading: false });
    } catch (err) {
      set({ loading: false, error: String(err) });
    }
  },

  saveProfile: async (profile: ConnectionProfile) => {
    set({ error: null });
    try {
      const id = await tauriInvoke<string>("save_profile", {
        profileData: profile,
      });
      // Reload profiles to sync state
      const profiles =
        await tauriInvoke<ConnectionProfile[]>("load_profiles");
      set({ profiles });
      return id;
    } catch (err) {
      set({ error: String(err) });
      throw err;
    }
  },

  deleteProfile: async (id: string) => {
    set({ error: null });
    try {
      await tauriInvoke<void>("delete_profile", { profileId: id });
      // Reload profiles to sync state
      const profiles =
        await tauriInvoke<ConnectionProfile[]>("load_profiles");
      set({ profiles });
    } catch (err) {
      set({ error: String(err) });
      throw err;
    }
  },

  storeCredential: async (profileId: string, password: string) => {
    try {
      await tauriInvoke<void>("store_credential", {
        profileId,
        credentialType: "password",
        value: password,
      });
    } catch (err) {
      // Non-blocking — log but don't prevent connection
      console.error("Failed to store credential:", err);
      set({ error: `Vault error: ${String(err)}` });
    }
  },

  exportProfiles: async (exportPath: string, includeCredentials: boolean, exportPassword?: string) => {
    set({ error: null });
    try {
      return await tauriInvoke<number>("export_profiles", {
        exportPath,
        includeCredentials,
        exportPassword: exportPassword ?? null,
      });
    } catch (err) {
      set({ error: String(err) });
      throw err;
    }
  },

  importProfiles: async (importPath: string, importPassword?: string) => {
    set({ error: null });
    try {
      const result = await tauriInvoke<ImportResult>("import_profiles", {
        importPath,
        importPassword: importPassword ?? null,
      });
      // Reload profiles to sync state after import
      const profiles =
        await tauriInvoke<ConnectionProfile[]>("load_profiles");
      set({ profiles });
      return result;
    } catch (err) {
      set({ error: String(err) });
      throw err;
    }
  },

  clearError: () => set({ error: null }),
}));
