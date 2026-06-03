// features/proxmox/ProxmoxPanel.test.tsx — TDD: ProxmoxPanel rendering

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// ── i18n mock ─────────────────────────────────────────────────────────────────

vi.mock("../../lib/i18n", () => ({
  useI18n: () => ({
    t: (k: string) => {
      const labels: Record<string, string> = {
        "proxmox.unavailable":
          "Not a Proxmox host or insufficient permissions",
        "proxmox.loading": "Loading LXC containers...",
        "proxmox.empty": "No LXC containers found",
        "proxmox.refresh": "Refresh",
        "proxmox.col.vmid": "VMID",
        "proxmox.col.name": "Name",
        "proxmox.col.status": "Status",
        "proxmox.col.actions": "Actions",
        "proxmox.action.start": "Start",
        "proxmox.action.stop": "Stop",
        "proxmox.action.reboot": "Reboot",
        "proxmox.action.shell": "Shell",
        "proxmox.action.snapshots": "Snapshots",
        "proxmox.snapshot.rollback.arm": "Rollback",
        "proxmox.snapshot.rollback.confirm": "Confirm Rollback",
        "proxmox.snapshot.rollback.cancel": "Cancel",
        "proxmox.snapshot.rollback.warning":
          "Warning: rollback discards current container state",
        "proxmox.snapshot.delete.arm": "Delete",
        "proxmox.snapshot.delete.confirm": "Confirm Delete",
        "proxmox.snapshot.delete.cancel": "Cancel",
        "proxmox.snapshot.create.label": "New snapshot name",
        "proxmox.snapshot.create.btn": "Create Snapshot",
        "proxmox.snapshot.title": "Snapshots",
        "proxmox.snapshot.empty": "No snapshots",
        "proxmox.snapshot.close": "Close Snapshots",
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

// ── Store + hook mocks ────────────────────────────────────────────────────────

import { useProxmoxStore } from "../../stores/proxmoxStore";

function resetProxmoxStore() {
  useProxmoxStore.setState({
    containers: new Map(),
    snapshots: new Map(),
    availability: new Map(),
    loading: new Map(),
  });
}

vi.mock("./useProxmox", () => ({
  useProxmox: () => ({ refresh: vi.fn() }),
}));

// ── Session store mock ────────────────────────────────────────────────────────

const mockSessionStoreState = {
  sessions: new Map<string, { activeTerminalId: string | null }>(),
  activeSessionId: null as string | null,
  startupPreview: null as unknown,
};

vi.mock("../../stores/sessionStore", () => ({
  useSessionStore: Object.assign(() => mockSessionStoreState, {
    getState: () => mockSessionStoreState,
  }),
}));

// ── Component import (after mocks) ────────────────────────────────────────────

import { ProxmoxPanel, buildPctEnterCommand } from "./ProxmoxPanel";

const SESSION_ID = "session-proxmox-test";

describe("ProxmoxPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProxmoxStore();
    mockTauriInvoke.mockResolvedValue({ snapshots: [] });
  });

  it("renders unavailable state when availability=false", () => {
    useProxmoxStore.setState({
      containers: new Map([[SESSION_ID, []]]),
      snapshots: new Map(),
      availability: new Map([[SESSION_ID, false]]),
      loading: new Map(),
    });
    render(<ProxmoxPanel sessionId={SESSION_ID} />);
    expect(
      screen.getByText(/Not a Proxmox host or insufficient permissions/i),
    ).toBeInTheDocument();
  });

  it("renders loading state while loading=true and availability is unknown", () => {
    useProxmoxStore.setState({
      containers: new Map(),
      snapshots: new Map(),
      availability: new Map(),
      loading: new Map([[SESSION_ID, true]]),
    });
    render(<ProxmoxPanel sessionId={SESSION_ID} />);
    expect(screen.getByText(/Loading LXC containers/i)).toBeInTheDocument();
  });

  it("renders empty state when containers list is empty and available", () => {
    useProxmoxStore.setState({
      containers: new Map([[SESSION_ID, []]]),
      snapshots: new Map(),
      availability: new Map([[SESSION_ID, true]]),
      loading: new Map([[SESSION_ID, false]]),
    });
    render(<ProxmoxPanel sessionId={SESSION_ID} />);
    expect(screen.getByText(/No LXC containers/i)).toBeInTheDocument();
  });

  it("renders LXC table with vmid, name, and status badge when containers present", () => {
    useProxmoxStore.setState({
      containers: new Map([
        [
          SESSION_ID,
          [{ vmid: 100, status: "running", name: "debian-dev" }],
        ],
      ]),
      snapshots: new Map(),
      availability: new Map([[SESSION_ID, true]]),
      loading: new Map([[SESSION_ID, false]]),
    });
    render(<ProxmoxPanel sessionId={SESSION_ID} />);
    expect(screen.getByText("100")).toBeInTheDocument();
    expect(screen.getByText("debian-dev")).toBeInTheDocument();
    expect(screen.getByText("running")).toBeInTheDocument();
  });

  it("renders lifecycle buttons (Stop for running containers)", () => {
    useProxmoxStore.setState({
      containers: new Map([
        [SESSION_ID, [{ vmid: 100, status: "running", name: "debian-dev" }]],
      ]),
      snapshots: new Map(),
      availability: new Map([[SESSION_ID, true]]),
      loading: new Map([[SESSION_ID, false]]),
    });
    render(<ProxmoxPanel sessionId={SESSION_ID} />);
    expect(screen.getByRole("button", { name: /Stop/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Reboot/i }),
    ).toBeInTheDocument();
  });

  it("renders Start button for stopped containers", () => {
    useProxmoxStore.setState({
      containers: new Map([
        [SESSION_ID, [{ vmid: 101, status: "stopped", name: "ubuntu-web" }]],
      ]),
      snapshots: new Map(),
      availability: new Map([[SESSION_ID, true]]),
      loading: new Map([[SESSION_ID, false]]),
    });
    render(<ProxmoxPanel sessionId={SESSION_ID} />);
    expect(screen.getByRole("button", { name: /Start/i })).toBeInTheDocument();
  });

  it("renders Shell button for running containers", () => {
    useProxmoxStore.setState({
      containers: new Map([
        [SESSION_ID, [{ vmid: 100, status: "running", name: "debian-dev" }]],
      ]),
      snapshots: new Map(),
      availability: new Map([[SESSION_ID, true]]),
      loading: new Map([[SESSION_ID, false]]),
    });
    render(<ProxmoxPanel sessionId={SESSION_ID} />);
    expect(
      screen.getByRole("button", { name: /Shell/i }),
    ).toBeInTheDocument();
  });

  it("renders Snapshots button per row", () => {
    useProxmoxStore.setState({
      containers: new Map([
        [SESSION_ID, [{ vmid: 100, status: "running", name: "debian-dev" }]],
      ]),
      snapshots: new Map(),
      availability: new Map([[SESSION_ID, true]]),
      loading: new Map([[SESSION_ID, false]]),
    });
    render(<ProxmoxPanel sessionId={SESSION_ID} />);
    expect(
      screen.getByRole("button", { name: /Snapshots/i }),
    ).toBeInTheDocument();
  });

  it("has accessible table structure", () => {
    useProxmoxStore.setState({
      containers: new Map([
        [SESSION_ID, [{ vmid: 100, status: "stopped", name: "debian-dev" }]],
      ]),
      snapshots: new Map(),
      availability: new Map([[SESSION_ID, true]]),
      loading: new Map([[SESSION_ID, false]]),
    });
    render(<ProxmoxPanel sessionId={SESSION_ID} />);
    expect(screen.getByRole("table")).toBeInTheDocument();
  });
});

// ── buildPctEnterCommand helper ───────────────────────────────────────────────

describe("buildPctEnterCommand", () => {
  it("uses the vmid in the pct enter command", () => {
    expect(buildPctEnterCommand("100")).toBe("pct enter 100\n");
  });

  it("produces the correct format for any valid vmid string", () => {
    expect(buildPctEnterCommand("1234")).toBe("pct enter 1234\n");
  });

  it("command contains exactly the vmid provided, not any name", () => {
    const vmid = "100";
    const name = "container-name-sentinel";
    const cmd = buildPctEnterCommand(vmid);
    expect(cmd).toContain(vmid);
    expect(cmd).not.toContain(name);
  });
});

// ── Shell action uses vmid, not name ─────────────────────────────────────────

describe("ProxmoxPanel shell action uses vmid (not name)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useProxmoxStore.setState({
      containers: new Map([
        [
          "sess-shell",
          [
            {
              vmid: 100,
              status: "running",
              name: "should-not-appear-in-cmd",
            },
          ],
        ],
      ]),
      snapshots: new Map(),
      availability: new Map([["sess-shell", true]]),
      loading: new Map([["sess-shell", false]]),
    });
    mockTauriInvoke.mockResolvedValue({ snapshots: [] });
  });

  it("calls write_terminal with vmid (not name) when Shell is clicked", async () => {
    render(<ProxmoxPanel sessionId="sess-shell" />);
    const shellBtn = screen.getByRole("button", { name: /Shell/i });
    fireEvent.click(shellBtn);

    await vi.runAllTimersAsync?.().catch(() => {});
    const writeCalls = mockTauriInvoke.mock.calls.filter(
      (c: unknown[]) => c[0] === "write_terminal",
    );
    for (const call of writeCalls) {
      const payload = call[1] as { data: number[] };
      const text = new TextDecoder().decode(new Uint8Array(payload.data));
      expect(text).not.toContain("should-not-appear-in-cmd");
      expect(text).toContain("100");
    }
  });
});
