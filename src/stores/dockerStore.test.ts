// stores/dockerStore.test.ts — TDD: per-session container state store

import { describe, it, expect, beforeEach } from "vitest";

import { useDockerStore, type ContainerRow } from "./dockerStore";

function resetStore() {
  useDockerStore.setState({
    containers: new Map(),
    availability: new Map(),
    loading: new Map(),
  });
}

function makeRow(id: string): ContainerRow {
  return {
    id,
    names: `container-${id}`,
    image: "nginx:latest",
    state: "running",
    status: "Up 1h",
    ports: "",
  };
}

describe("dockerStore — containers", () => {
  beforeEach(resetStore);

  it("setContainers stores rows per sessionId", () => {
    const { setContainers } = useDockerStore.getState();
    const rows = [makeRow("aaa"), makeRow("bbb")];
    setContainers("session-1", rows);
    expect(useDockerStore.getState().containers.get("session-1")).toHaveLength(2);
  });

  it("setContainers replaces previous rows for the same session", () => {
    const { setContainers } = useDockerStore.getState();
    setContainers("session-1", [makeRow("aaa")]);
    setContainers("session-1", [makeRow("bbb"), makeRow("ccc")]);
    const rows = useDockerStore.getState().containers.get("session-1");
    expect(rows).toHaveLength(2);
    expect(rows![0]!.id).toBe("bbb");
  });

  it("setContainers does not affect other sessions", () => {
    const { setContainers } = useDockerStore.getState();
    setContainers("session-a", [makeRow("aaa")]);
    setContainers("session-b", [makeRow("bbb"), makeRow("ccc")]);
    expect(useDockerStore.getState().containers.get("session-a")).toHaveLength(1);
    expect(useDockerStore.getState().containers.get("session-b")).toHaveLength(2);
  });
});

describe("dockerStore — availability", () => {
  beforeEach(resetStore);

  it("availability is undefined (unknown) by default", () => {
    expect(useDockerStore.getState().availability.get("session-x")).toBeUndefined();
  });

  it("setAvailability true marks session as available", () => {
    useDockerStore.getState().setAvailability("session-1", true);
    expect(useDockerStore.getState().availability.get("session-1")).toBe(true);
  });

  it("setAvailability false marks session as unavailable", () => {
    useDockerStore.getState().setAvailability("session-1", false);
    expect(useDockerStore.getState().availability.get("session-1")).toBe(false);
  });
});

describe("dockerStore — loading", () => {
  beforeEach(resetStore);

  it("loading is false by default", () => {
    expect(useDockerStore.getState().loading.get("session-x")).toBeFalsy();
  });

  it("setLoading true marks session as loading", () => {
    useDockerStore.getState().setLoading("session-1", true);
    expect(useDockerStore.getState().loading.get("session-1")).toBe(true);
  });

  it("setLoading false clears loading", () => {
    useDockerStore.getState().setLoading("session-1", true);
    useDockerStore.getState().setLoading("session-1", false);
    expect(useDockerStore.getState().loading.get("session-1")).toBe(false);
  });
});

describe("dockerStore — clearSession", () => {
  beforeEach(resetStore);

  it("clearSession removes containers, availability, and loading for the session", () => {
    const store = useDockerStore.getState();
    store.setContainers("session-1", [makeRow("aaa")]);
    store.setAvailability("session-1", true);
    store.setLoading("session-1", true);

    useDockerStore.getState().clearSession("session-1");

    const state = useDockerStore.getState();
    expect(state.containers.get("session-1")).toBeUndefined();
    expect(state.availability.get("session-1")).toBeUndefined();
    expect(state.loading.get("session-1")).toBeUndefined();
  });

  it("clearSession does not affect other sessions", () => {
    const store = useDockerStore.getState();
    store.setContainers("session-a", [makeRow("aaa")]);
    store.setContainers("session-b", [makeRow("bbb")]);

    useDockerStore.getState().clearSession("session-a");

    expect(useDockerStore.getState().containers.get("session-b")).toHaveLength(1);
  });
});
