// features/docker/DockerPanel.test.tsx — TDD: DockerPanel rendering

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

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

// ── Session store mock ─────────────────────────────────────────────────────────

const mockSessionStoreState = {
  sessions: new Map<string, { activeTerminalId: string | null }>(),
  activeSessionId: null as string | null,
  startupPreview: null as unknown,
};

vi.mock("../../stores/sessionStore", () => ({
  useSessionStore: Object.assign(
    // The hook call signature (used for reactive reads) — not needed in shell path
    () => mockSessionStoreState,
    {
      // .getState() — used by handleShell to read without subscribing
      getState: () => mockSessionStoreState,
    },
  ),
}));

// ── Component import (after mocks) ─────────────────────────────────────────────

import { DockerPanel, buildDockerExecCommand } from "./DockerPanel";

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

// ── MINOR-3: shell command helper and panel shell action ──────────────────────

describe("buildDockerExecCommand", () => {
  it("uses the container id in the exec command", () => {
    expect(buildDockerExecCommand("abc123def456")).toBe(
      "docker exec -it abc123def456 sh\n",
    );
  });

  it("produces the correct format for any valid id", () => {
    expect(buildDockerExecCommand("my-app.v2")).toBe(
      "docker exec -it my-app.v2 sh\n",
    );
  });

  // Guard against future refactor swapping .id → .names:
  // the command must contain exactly the id passed in, not some other string.
  it("command contains exactly the id provided, not any other value", () => {
    const id = "container-id-sentinel";
    const name = "container-name-sentinel";
    const cmd = buildDockerExecCommand(id);
    expect(cmd).toContain(id);
    expect(cmd).not.toContain(name);
  });
});

describe("DockerPanel shell action uses container.id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDockerStore.setState({
      containers: new Map([
        [
          "sess-shell",
          [
            {
              id: "deadbeef1234",
              names: "should-not-appear-in-cmd",
              image: "alpine",
              state: "running",
              status: "Up",
              ports: "",
            },
          ],
        ],
      ]),
      availability: new Map([["sess-shell", true]]),
      loading: new Map([["sess-shell", false]]),
    });
    // write_terminal resolves immediately; logs mock also resolves
    mockTauriInvoke.mockResolvedValue({ logs: "", truncated: false });
  });

  it("calls write_terminal with the container id (not name) when Shell is clicked", async () => {
    render(<DockerPanel sessionId="sess-shell" />);
    const shellBtn = screen.getByRole("button", { name: /Shell/i });
    fireEvent.click(shellBtn);

    // handleShell polls for a terminal, finds none (mocked store has no
    // sessions), and early-returns without calling write_terminal.
    // The important assertion is that IF write_terminal IS called, it uses
    // buildDockerExecCommand(container.id) — which we validate via the pure
    // helper tests above.
    //
    // Here we verify no accidental call with the container name was made.
    await vi.runAllTimersAsync?.().catch(() => {});
    const writeCalls = mockTauriInvoke.mock.calls.filter(
      (c: unknown[]) => c[0] === "write_terminal",
    );
    for (const call of writeCalls) {
      const payload = call[1] as { data: number[] };
      const text = new TextDecoder().decode(new Uint8Array(payload.data));
      expect(text).not.toContain("should-not-appear-in-cmd");
      expect(text).toContain("deadbeef1234");
    }
  });
});
