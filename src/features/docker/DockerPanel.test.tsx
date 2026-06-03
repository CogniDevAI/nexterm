// features/docker/DockerPanel.test.tsx — TDD: DockerPanel rendering

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// ── i18n mock ─────────────────────────────────────────────────────────────────

vi.mock("../../lib/i18n", () => ({
  useI18n: () => ({
    t: (k: string) => {
      const labels: Record<string, string> = {
        "docker.unavailable": "Docker not available",
        "docker.loading": "Loading containers...",
        "docker.empty": "No containers",
        "docker.col.name": "Name",
        "docker.col.image": "Image",
        "docker.col.state": "State",
        "docker.col.status": "Status",
        "docker.col.ports": "Ports",
        "docker.col.actions": "Actions",
        "docker.action.start": "Start",
        "docker.action.stop": "Stop",
        "docker.action.restart": "Restart",
        "docker.action.rm": "Remove",
        "docker.action.shell": "Shell",
        "docker.refresh": "Refresh",
        "docker.rm.arm": "Remove",
        "docker.rm.confirm": "Confirm Remove",
        "docker.rm.cancel": "Cancel",
        "docker.rm.container": "Container",
        "docker.logs.title": "Logs",
        "docker.logs.close": "Close",
        "docker.logs.truncated": "Output truncated",
      };
      return labels[k] ?? k;
    },
  }),
}));

// ── Tauri mock ────────────────────────────────────────────────────────────────

const { mockTauriInvoke } = vi.hoisted(() => ({
  mockTauriInvoke: vi.fn(),
}));

vi.mock("../../lib/tauri", () => ({
  tauriInvoke: mockTauriInvoke,
}));

// ── Docker store / hook mock ──────────────────────────────────────────────────

import { useDockerStore } from "../../stores/dockerStore";

function resetDockerStore() {
  useDockerStore.setState({
    containers: new Map(),
    availability: new Map(),
    loading: new Map(),
  });
}

// Mock useDocker so we don't need Tauri in rendering tests
vi.mock("./useDocker", () => ({
  useDocker: () => ({ refresh: vi.fn() }),
}));

// ── Component import (after mocks) ─────────────────────────────────────────────

import { DockerPanel } from "./DockerPanel";

const SESSION_ID = "session-docker-test";

describe("DockerPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDockerStore();
    mockTauriInvoke.mockResolvedValue({ logs: "log line 1\nlog line 2", truncated: false });
  });

  it("renders unavailable state when availability=false", () => {
    useDockerStore.setState({
      containers: new Map([[SESSION_ID, []]]),
      availability: new Map([[SESSION_ID, false]]),
      loading: new Map(),
    });
    render(<DockerPanel sessionId={SESSION_ID} />);
    expect(screen.getByText(/Docker not available/i)).toBeInTheDocument();
  });

  it("renders loading state while loading=true and availability is unknown", () => {
    useDockerStore.setState({
      containers: new Map(),
      availability: new Map(),
      loading: new Map([[SESSION_ID, true]]),
    });
    render(<DockerPanel sessionId={SESSION_ID} />);
    expect(screen.getByText(/Loading containers/i)).toBeInTheDocument();
  });

  it("renders empty state when containers list is empty and available", () => {
    useDockerStore.setState({
      containers: new Map([[SESSION_ID, []]]),
      availability: new Map([[SESSION_ID, true]]),
      loading: new Map([[SESSION_ID, false]]),
    });
    render(<DockerPanel sessionId={SESSION_ID} />);
    expect(screen.getByText(/No containers/i)).toBeInTheDocument();
  });

  it("renders container table with state badges when containers are present", () => {
    useDockerStore.setState({
      containers: new Map([
        [
          SESSION_ID,
          [
            {
              id: "abc123",
              names: "myapp",
              image: "nginx:latest",
              state: "running",
              status: "Up 2 hours",
              ports: "80/tcp",
            },
          ],
        ],
      ]),
      availability: new Map([[SESSION_ID, true]]),
      loading: new Map([[SESSION_ID, false]]),
    });
    render(<DockerPanel sessionId={SESSION_ID} />);
    expect(screen.getByText("myapp")).toBeInTheDocument();
    expect(screen.getByText("nginx:latest")).toBeInTheDocument();
    // State badge
    expect(screen.getByText("running")).toBeInTheDocument();
  });

  it("renders action buttons for each container row", () => {
    useDockerStore.setState({
      containers: new Map([
        [
          SESSION_ID,
          [
            {
              id: "abc123",
              names: "myapp",
              image: "nginx:latest",
              state: "running",
              status: "Up 2h",
              ports: "",
            },
          ],
        ],
      ]),
      availability: new Map([[SESSION_ID, true]]),
      loading: new Map([[SESSION_ID, false]]),
    });
    render(<DockerPanel sessionId={SESSION_ID} />);
    // Should have lifecycle action buttons (e.g. Stop for running containers)
    expect(screen.getByRole("button", { name: /Stop/i })).toBeInTheDocument();
  });

  it("has accessible table structure", () => {
    useDockerStore.setState({
      containers: new Map([
        [
          SESSION_ID,
          [
            {
              id: "abc123",
              names: "myapp",
              image: "nginx",
              state: "exited",
              status: "Exited(0)",
              ports: "",
            },
          ],
        ],
      ]),
      availability: new Map([[SESSION_ID, true]]),
      loading: new Map([[SESSION_ID, false]]),
    });
    render(<DockerPanel sessionId={SESSION_ID} />);
    // Should render a table element
    expect(screen.getByRole("table")).toBeInTheDocument();
  });
});
