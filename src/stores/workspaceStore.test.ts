// src/stores/workspaceStore.test.ts — TDD: panelSection + panelOpen fields

import { describe, it, expect, beforeEach } from "vitest";
import { vi } from "vitest";

// localStorage stub — must be set up via vi.hoisted so it is in place
// before any module is imported (Zustand persist reads localStorage at store-create time).
vi.hoisted(() => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => void store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
});

import { useWorkspaceStore, buildWorkspaceKey } from "./workspaceStore";

function resetStore() {
  useWorkspaceStore.setState({ workspaces: {} });
}

describe("workspaceStore — panelSection + panelOpen", () => {
  beforeEach(() => {
    resetStore();
  });

  it("new workspace defaults panelSection to null and panelOpen to false", () => {
    const ws = useWorkspaceStore
      .getState()
      .getOrCreateWorkspace("profile-1", "user-1");
    expect(ws.panelSection).toBeNull();
    expect(ws.panelOpen).toBe(false);
  });

  it("setPanelSection sets the panelSection field", () => {
    const ws = useWorkspaceStore
      .getState()
      .getOrCreateWorkspace("profile-1", "user-1");
    const key = buildWorkspaceKey("profile-1", "user-1");
    useWorkspaceStore.getState().setPanelSection(key, "sftp");
    const updated = useWorkspaceStore.getState().workspaces[key];
    expect(updated.panelSection).toBe("sftp");
  });

  it("setPanelSection accepts null to close panel section", () => {
    const ws = useWorkspaceStore
      .getState()
      .getOrCreateWorkspace("profile-1", "user-1");
    const key = buildWorkspaceKey("profile-1", "user-1");
    useWorkspaceStore.getState().setPanelSection(key, "sftp");
    useWorkspaceStore.getState().setPanelSection(key, null);
    const updated = useWorkspaceStore.getState().workspaces[key];
    expect(updated.panelSection).toBeNull();
  });

  it("setPanelOpen sets panelOpen field", () => {
    const ws = useWorkspaceStore
      .getState()
      .getOrCreateWorkspace("profile-1", "user-1");
    const key = buildWorkspaceKey("profile-1", "user-1");
    useWorkspaceStore.getState().setPanelOpen(key, true);
    const updated = useWorkspaceStore.getState().workspaces[key];
    expect(updated.panelOpen).toBe(true);
  });

  it("setPanelOpen to false closes the panel", () => {
    const ws = useWorkspaceStore
      .getState()
      .getOrCreateWorkspace("profile-1", "user-1");
    const key = buildWorkspaceKey("profile-1", "user-1");
    useWorkspaceStore.getState().setPanelOpen(key, true);
    useWorkspaceStore.getState().setPanelOpen(key, false);
    const updated = useWorkspaceStore.getState().workspaces[key];
    expect(updated.panelOpen).toBe(false);
  });

  it("does nothing when workspaceKey not found in setPanelSection", () => {
    const before = { ...useWorkspaceStore.getState().workspaces };
    useWorkspaceStore.getState().setPanelSection("missing-key", "tunnel");
    expect(useWorkspaceStore.getState().workspaces).toEqual(before);
  });

  it("does nothing when workspaceKey not found in setPanelOpen", () => {
    const before = { ...useWorkspaceStore.getState().workspaces };
    useWorkspaceStore.getState().setPanelOpen("missing-key", true);
    expect(useWorkspaceStore.getState().workspaces).toEqual(before);
  });
});
