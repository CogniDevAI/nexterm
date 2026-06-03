// src/stores/workspaceStore.test.ts — TDD: panelSection + panelOpen + mainView fields

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

import {
  useWorkspaceStore,
  buildWorkspaceKey,
  PANEL_WIDTH_DEFAULT,
  PANEL_WIDTH_MIN,
  PANEL_WIDTH_MAX,
} from "./workspaceStore";

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
    useWorkspaceStore.getState().getOrCreateWorkspace("profile-1", "user-1");
    const key = buildWorkspaceKey("profile-1", "user-1");
    useWorkspaceStore.getState().setPanelSection(key, "sftp");
    const updated = useWorkspaceStore.getState().workspaces[key]!;
    expect(updated.panelSection).toBe("sftp");
  });

  it("setPanelSection accepts null to close panel section", () => {
    useWorkspaceStore.getState().getOrCreateWorkspace("profile-1", "user-1");
    const key = buildWorkspaceKey("profile-1", "user-1");
    useWorkspaceStore.getState().setPanelSection(key, "sftp");
    useWorkspaceStore.getState().setPanelSection(key, null);
    const updated = useWorkspaceStore.getState().workspaces[key]!;
    expect(updated.panelSection).toBeNull();
  });

  it("setPanelOpen sets panelOpen field", () => {
    useWorkspaceStore.getState().getOrCreateWorkspace("profile-1", "user-1");
    const key = buildWorkspaceKey("profile-1", "user-1");
    useWorkspaceStore.getState().setPanelOpen(key, true);
    const updated = useWorkspaceStore.getState().workspaces[key]!;
    expect(updated.panelOpen).toBe(true);
  });

  it("setPanelOpen to false closes the panel", () => {
    useWorkspaceStore.getState().getOrCreateWorkspace("profile-1", "user-1");
    const key = buildWorkspaceKey("profile-1", "user-1");
    useWorkspaceStore.getState().setPanelOpen(key, true);
    useWorkspaceStore.getState().setPanelOpen(key, false);
    const updated = useWorkspaceStore.getState().workspaces[key]!;
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

describe("workspaceStore — mainView", () => {
  beforeEach(() => {
    resetStore();
  });

  it("new workspace defaults mainView to 'terminal'", () => {
    const ws = useWorkspaceStore
      .getState()
      .getOrCreateWorkspace("profile-1", "user-1");
    expect(ws.mainView).toBe("terminal");
  });

  it("setMainView updates mainView to 'files'", () => {
    useWorkspaceStore.getState().getOrCreateWorkspace("profile-1", "user-1");
    const key = buildWorkspaceKey("profile-1", "user-1");
    useWorkspaceStore.getState().setMainView(key, "files");
    const updated = useWorkspaceStore.getState().workspaces[key]!;
    expect(updated.mainView).toBe("files");
  });

  it("setMainView updates mainView back to 'terminal'", () => {
    useWorkspaceStore.getState().getOrCreateWorkspace("profile-1", "user-1");
    const key = buildWorkspaceKey("profile-1", "user-1");
    useWorkspaceStore.getState().setMainView(key, "files");
    useWorkspaceStore.getState().setMainView(key, "terminal");
    const updated = useWorkspaceStore.getState().workspaces[key]!;
    expect(updated.mainView).toBe("terminal");
  });

  it("setMainView is independent per workspace key", () => {
    useWorkspaceStore.getState().getOrCreateWorkspace("profile-a", "user-1");
    useWorkspaceStore.getState().getOrCreateWorkspace("profile-b", "user-1");
    const keyA = buildWorkspaceKey("profile-a", "user-1");
    const keyB = buildWorkspaceKey("profile-b", "user-1");

    useWorkspaceStore.getState().setMainView(keyA, "files");

    expect(useWorkspaceStore.getState().workspaces[keyA]!.mainView).toBe("files");
    expect(useWorkspaceStore.getState().workspaces[keyB]!.mainView).toBe("terminal");
  });

  it("does nothing when workspaceKey not found in setMainView", () => {
    const before = { ...useWorkspaceStore.getState().workspaces };
    useWorkspaceStore.getState().setMainView("missing-key", "files");
    expect(useWorkspaceStore.getState().workspaces).toEqual(before);
  });

  it("setMainView updates mainView to 'editor'", () => {
    useWorkspaceStore.getState().getOrCreateWorkspace("profile-1", "user-1");
    const key = buildWorkspaceKey("profile-1", "user-1");
    useWorkspaceStore.getState().setMainView(key, "editor");
    const updated = useWorkspaceStore.getState().workspaces[key]!;
    expect(updated.mainView).toBe("editor");
  });
});

describe("workspaceStore — panelWidth", () => {
  beforeEach(() => {
    resetStore();
  });

  it("new workspace defaults panelWidth to PANEL_WIDTH_DEFAULT (420)", () => {
    const ws = useWorkspaceStore
      .getState()
      .getOrCreateWorkspace("profile-1", "user-1");
    expect(ws.panelWidth).toBe(PANEL_WIDTH_DEFAULT);
    expect(ws.panelWidth).toBe(420);
  });

  it("setPanelWidth sets a valid width within bounds", () => {
    useWorkspaceStore.getState().getOrCreateWorkspace("profile-1", "user-1");
    const key = buildWorkspaceKey("profile-1", "user-1");
    useWorkspaceStore.getState().setPanelWidth(key, 500);
    expect(useWorkspaceStore.getState().workspaces[key]!.panelWidth).toBe(500);
  });

  it("setPanelWidth clamps to PANEL_WIDTH_MIN (320) when below minimum", () => {
    useWorkspaceStore.getState().getOrCreateWorkspace("profile-1", "user-1");
    const key = buildWorkspaceKey("profile-1", "user-1");
    useWorkspaceStore.getState().setPanelWidth(key, 100);
    expect(useWorkspaceStore.getState().workspaces[key]!.panelWidth).toBe(PANEL_WIDTH_MIN);
  });

  it("setPanelWidth clamps to PANEL_WIDTH_MAX (820) when above maximum", () => {
    useWorkspaceStore.getState().getOrCreateWorkspace("profile-1", "user-1");
    const key = buildWorkspaceKey("profile-1", "user-1");
    useWorkspaceStore.getState().setPanelWidth(key, 9999);
    expect(useWorkspaceStore.getState().workspaces[key]!.panelWidth).toBe(PANEL_WIDTH_MAX);
  });

  it("setPanelWidth accepts the exact minimum boundary (320)", () => {
    useWorkspaceStore.getState().getOrCreateWorkspace("profile-1", "user-1");
    const key = buildWorkspaceKey("profile-1", "user-1");
    useWorkspaceStore.getState().setPanelWidth(key, PANEL_WIDTH_MIN);
    expect(useWorkspaceStore.getState().workspaces[key]!.panelWidth).toBe(PANEL_WIDTH_MIN);
  });

  it("setPanelWidth accepts the exact maximum boundary (820)", () => {
    useWorkspaceStore.getState().getOrCreateWorkspace("profile-1", "user-1");
    const key = buildWorkspaceKey("profile-1", "user-1");
    useWorkspaceStore.getState().setPanelWidth(key, PANEL_WIDTH_MAX);
    expect(useWorkspaceStore.getState().workspaces[key]!.panelWidth).toBe(PANEL_WIDTH_MAX);
  });

  it("setPanelWidth is independent per workspace key", () => {
    useWorkspaceStore.getState().getOrCreateWorkspace("profile-a", "user-1");
    useWorkspaceStore.getState().getOrCreateWorkspace("profile-b", "user-1");
    const keyA = buildWorkspaceKey("profile-a", "user-1");
    const keyB = buildWorkspaceKey("profile-b", "user-1");

    useWorkspaceStore.getState().setPanelWidth(keyA, 600);

    expect(useWorkspaceStore.getState().workspaces[keyA]!.panelWidth).toBe(600);
    expect(useWorkspaceStore.getState().workspaces[keyB]!.panelWidth).toBe(PANEL_WIDTH_DEFAULT);
  });

  it("does nothing when workspaceKey not found in setPanelWidth", () => {
    const before = { ...useWorkspaceStore.getState().workspaces };
    useWorkspaceStore.getState().setPanelWidth("missing-key", 500);
    expect(useWorkspaceStore.getState().workspaces).toEqual(before);
  });
});
