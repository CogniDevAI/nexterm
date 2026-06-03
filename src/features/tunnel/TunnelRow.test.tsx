// features/tunnel/TunnelRow.test.tsx — TDD tests for dynamic tunnel row rendering
//
// Scope: -D badge, "→ SOCKS5" endpoint label, regression for -L/-R.

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TunnelRow } from "./TunnelRow";
import type { TunnelInfo } from "../../lib/types";

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock("../../lib/i18n", () => ({
  useI18n: () => ({ t: (k: string) => k }),
}));

// ─── Fixtures ────────────────────────────────────────────────────────────────

const dynamicTunnel: TunnelInfo = {
  config: {
    id: "00000000-0000-0000-0000-000000000001",
    tunnelType: "dynamic",
    bindHost: "127.0.0.1",
    bindPort: 1080,
    targetHost: "",
    targetPort: 0,
    label: "SOCKS proxy",
  },
  state: "stopped",
  bytesIn: 0,
  bytesOut: 0,
  activeConnections: 0,
};

const localTunnel: TunnelInfo = {
  config: {
    id: "00000000-0000-0000-0000-000000000002",
    tunnelType: "local",
    bindHost: "127.0.0.1",
    bindPort: 8080,
    targetHost: "db.internal",
    targetPort: 5432,
    label: "Database",
  },
  state: "stopped",
  bytesIn: 0,
  bytesOut: 0,
  activeConnections: 0,
};

const remoteTunnel: TunnelInfo = {
  config: {
    id: "00000000-0000-0000-0000-000000000003",
    tunnelType: "remote",
    bindHost: "0.0.0.0",
    bindPort: 9090,
    targetHost: "localhost",
    targetPort: 3000,
    label: "Remote forward",
  },
  state: "stopped",
  bytesIn: 0,
  bytesOut: 0,
  activeConnections: 0,
};

const NOOP = () => {};

// ─── Dynamic tunnel row tests ─────────────────────────────────────────────────

describe("TunnelRow with tunnelType=dynamic", () => {
  it("shows -D badge", () => {
    render(<TunnelRow tunnel={dynamicTunnel} onStart={NOOP} onStop={NOOP} onDelete={NOOP} />);
    const badge = screen.getByTitle("tunnel.dynamicForward");
    expect(badge.textContent).toBe("-D");
  });

  it("shows bind host and port in the endpoint", () => {
    render(<TunnelRow tunnel={dynamicTunnel} onStart={NOOP} onStop={NOOP} onDelete={NOOP} />);
    expect(screen.getByText("127.0.0.1:1080")).toBeInTheDocument();
  });

  it("shows SOCKS5 as the destination instead of targetHost:targetPort", () => {
    render(<TunnelRow tunnel={dynamicTunnel} onStart={NOOP} onStop={NOOP} onDelete={NOOP} />);
    expect(screen.getByText("SOCKS5")).toBeInTheDocument();
  });

  it("does NOT show empty targetHost:targetPort (0.0.0.0:0 or :0)", () => {
    render(<TunnelRow tunnel={dynamicTunnel} onStart={NOOP} onStop={NOOP} onDelete={NOOP} />);
    // Should not render ":0" or the empty target
    expect(screen.queryByText(/:0$/)).toBeNull();
  });
});

// ─── -L and -R regression ─────────────────────────────────────────────────────

describe("TunnelRow with tunnelType=local (regression)", () => {
  it("shows -L badge", () => {
    render(<TunnelRow tunnel={localTunnel} onStart={NOOP} onStop={NOOP} onDelete={NOOP} />);
    const badge = screen.getByTitle("tunnel.localForward");
    expect(badge.textContent).toBe("-L");
  });

  it("shows targetHost:targetPort as destination", () => {
    render(<TunnelRow tunnel={localTunnel} onStart={NOOP} onStop={NOOP} onDelete={NOOP} />);
    expect(screen.getByText("db.internal:5432")).toBeInTheDocument();
  });
});

describe("TunnelRow with tunnelType=remote (regression)", () => {
  it("shows -R badge", () => {
    render(<TunnelRow tunnel={remoteTunnel} onStart={NOOP} onStop={NOOP} onDelete={NOOP} />);
    const badge = screen.getByTitle("tunnel.remoteForward");
    expect(badge.textContent).toBe("-R");
  });
});
