// stores/proxmoxStore.test.ts — TDD: per-session LXC container state store

import { describe, it, expect, beforeEach } from "vitest";

import { useProxmoxStore, type LxcRow, type SnapshotRow } from "./proxmoxStore";

function resetStore() {
  useProxmoxStore.setState({
    containers: new Map(),
    snapshots: new Map(),
    availability: new Map(),
    loading: new Map(),
  });
}

function makeLxcRow(vmid: number): LxcRow {
  return {
    vmid,
    status: "running",
    name: `ct-${vmid}`,
  };
}

function makeSnapshot(name: string): SnapshotRow {
  return { name };
}

describe("proxmoxStore — containers", () => {
  beforeEach(resetStore);

  it("setLxc stores rows per sessionId", () => {
    const { setLxc } = useProxmoxStore.getState();
    const rows = [makeLxcRow(100), makeLxcRow(101)];
    setLxc("session-1", rows);
    expect(useProxmoxStore.getState().containers.get("session-1")).toHaveLength(2);
  });

  it("setLxc replaces previous rows for the same session", () => {
    const { setLxc } = useProxmoxStore.getState();
    setLxc("session-1", [makeLxcRow(100)]);
    setLxc("session-1", [makeLxcRow(101), makeLxcRow(102)]);
    const rows = useProxmoxStore.getState().containers.get("session-1");
    expect(rows).toHaveLength(2);
    expect(rows![0]!.vmid).toBe(101);
  });

  it("setLxc does not affect other sessions", () => {
    const { setLxc } = useProxmoxStore.getState();
    setLxc("session-a", [makeLxcRow(100)]);
    setLxc("session-b", [makeLxcRow(200), makeLxcRow(201)]);
    expect(useProxmoxStore.getState().containers.get("session-a")).toHaveLength(1);
    expect(useProxmoxStore.getState().containers.get("session-b")).toHaveLength(2);
  });
});

describe("proxmoxStore — snapshots", () => {
  beforeEach(resetStore);

  it("setSnapshots stores snapshots per session+vmid key", () => {
    const { setSnapshots } = useProxmoxStore.getState();
    setSnapshots("session-1", 100, [makeSnapshot("snap1"), makeSnapshot("snap2")]);
    const key = "session-1:100";
    expect(useProxmoxStore.getState().snapshots.get(key)).toHaveLength(2);
  });

  it("setSnapshots replaces existing snapshots for same key", () => {
    const { setSnapshots } = useProxmoxStore.getState();
    setSnapshots("session-1", 100, [makeSnapshot("snap1")]);
    setSnapshots("session-1", 100, [makeSnapshot("snap2"), makeSnapshot("snap3")]);
    const key = "session-1:100";
    const snaps = useProxmoxStore.getState().snapshots.get(key);
    expect(snaps).toHaveLength(2);
    expect(snaps![0]!.name).toBe("snap2");
  });

  it("setSnapshots is keyed by both sessionId and vmid", () => {
    const { setSnapshots } = useProxmoxStore.getState();
    setSnapshots("session-1", 100, [makeSnapshot("snap-a")]);
    setSnapshots("session-1", 101, [makeSnapshot("snap-b")]);
    expect(useProxmoxStore.getState().snapshots.get("session-1:100")).toHaveLength(1);
    expect(useProxmoxStore.getState().snapshots.get("session-1:101")).toHaveLength(1);
  });
});

describe("proxmoxStore — availability", () => {
  beforeEach(resetStore);

  it("availability is undefined (unknown) by default", () => {
    expect(useProxmoxStore.getState().availability.get("session-x")).toBeUndefined();
  });

  it("setAvailability true marks session as available", () => {
    useProxmoxStore.getState().setAvailability("session-1", true);
    expect(useProxmoxStore.getState().availability.get("session-1")).toBe(true);
  });

  it("setAvailability false marks session as unavailable", () => {
    useProxmoxStore.getState().setAvailability("session-1", false);
    expect(useProxmoxStore.getState().availability.get("session-1")).toBe(false);
  });
});

describe("proxmoxStore — loading", () => {
  beforeEach(resetStore);

  it("loading is undefined by default", () => {
    expect(useProxmoxStore.getState().loading.get("session-x")).toBeFalsy();
  });

  it("setLoading true marks session as loading", () => {
    useProxmoxStore.getState().setLoading("session-1", true);
    expect(useProxmoxStore.getState().loading.get("session-1")).toBe(true);
  });

  it("setLoading false clears loading", () => {
    useProxmoxStore.getState().setLoading("session-1", true);
    useProxmoxStore.getState().setLoading("session-1", false);
    expect(useProxmoxStore.getState().loading.get("session-1")).toBe(false);
  });
});

describe("proxmoxStore — clearSession", () => {
  beforeEach(resetStore);

  it("clearSession removes containers, snapshots, availability, and loading for the session", () => {
    const store = useProxmoxStore.getState();
    store.setLxc("session-1", [makeLxcRow(100)]);
    store.setSnapshots("session-1", 100, [makeSnapshot("snap1")]);
    store.setAvailability("session-1", true);
    store.setLoading("session-1", true);

    useProxmoxStore.getState().clearSession("session-1");

    const state = useProxmoxStore.getState();
    expect(state.containers.get("session-1")).toBeUndefined();
    expect(state.snapshots.get("session-1:100")).toBeUndefined();
    expect(state.availability.get("session-1")).toBeUndefined();
    expect(state.loading.get("session-1")).toBeUndefined();
  });

  it("clearSession does not affect other sessions", () => {
    const store = useProxmoxStore.getState();
    store.setLxc("session-a", [makeLxcRow(100)]);
    store.setLxc("session-b", [makeLxcRow(200)]);

    useProxmoxStore.getState().clearSession("session-a");

    expect(useProxmoxStore.getState().containers.get("session-b")).toHaveLength(1);
  });
});
