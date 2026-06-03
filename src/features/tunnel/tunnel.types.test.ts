// features/tunnel/tunnel.types.test.ts — Unit tests for tunnel form validation helpers
//
// TDD: these tests were written BEFORE the production code was updated.
// They define the acceptance criteria for validateTunnelForm with Dynamic tunnels.

import { describe, it, expect } from "vitest";
import {
  validateTunnelForm,
  getTunnelStateLabel,
  getTunnelStateIndicator,
  getActiveConnections,
  getTunnelErrorMessage,
} from "./tunnel.types";
import type { TunnelFormData } from "./tunnel.types";

// ── validateTunnelForm — Dynamic type ─────────────────────────────────────────

describe("validateTunnelForm with tunnelType=dynamic", () => {
  const validDynamicForm: TunnelFormData = {
    tunnelType: "dynamic",
    bindHost: "127.0.0.1",
    bindPort: "1080",
    targetHost: "",   // not required for dynamic
    targetPort: "",   // not required for dynamic
    label: "",
  };

  it("accepts a valid dynamic form (only bindHost + bindPort required)", () => {
    const errors = validateTunnelForm(validDynamicForm);
    expect(Object.keys(errors)).toHaveLength(0);
  });

  it("rejects dynamic form with missing bindHost", () => {
    const form: TunnelFormData = { ...validDynamicForm, bindHost: "" };
    const errors = validateTunnelForm(form);
    expect(errors.bindHost).toBeTruthy();
  });

  it("rejects dynamic form with missing bindPort", () => {
    const form: TunnelFormData = { ...validDynamicForm, bindPort: "" };
    const errors = validateTunnelForm(form);
    expect(errors.bindPort).toBeTruthy();
  });

  it("does NOT require targetHost for dynamic tunnel", () => {
    const form: TunnelFormData = { ...validDynamicForm, targetHost: "" };
    const errors = validateTunnelForm(form);
    expect(errors.targetHost).toBeUndefined();
  });

  it("does NOT require targetPort for dynamic tunnel", () => {
    const form: TunnelFormData = { ...validDynamicForm, targetPort: "" };
    const errors = validateTunnelForm(form);
    expect(errors.targetPort).toBeUndefined();
  });

  it("rejects out-of-range bindPort for dynamic tunnel", () => {
    const form: TunnelFormData = { ...validDynamicForm, bindPort: "99999" };
    const errors = validateTunnelForm(form);
    expect(errors.bindPort).toBeTruthy();
  });
});

// ── validateTunnelForm — local type (regression guard) ───────────────────────

describe("validateTunnelForm with tunnelType=local (regression)", () => {
  const validLocalForm: TunnelFormData = {
    tunnelType: "local",
    bindHost: "127.0.0.1",
    bindPort: "8080",
    targetHost: "db.internal",
    targetPort: "5432",
    label: "",
  };

  it("accepts a valid local form", () => {
    const errors = validateTunnelForm(validLocalForm);
    expect(Object.keys(errors)).toHaveLength(0);
  });

  it("rejects local form with missing targetHost", () => {
    const form: TunnelFormData = { ...validLocalForm, targetHost: "" };
    const errors = validateTunnelForm(form);
    expect(errors.targetHost).toBeTruthy();
  });

  it("rejects local form with missing targetPort", () => {
    const form: TunnelFormData = { ...validLocalForm, targetPort: "" };
    const errors = validateTunnelForm(form);
    expect(errors.targetPort).toBeTruthy();
  });
});

// ── validateTunnelForm — remote type (regression guard) ──────────────────────

describe("validateTunnelForm with tunnelType=remote (regression)", () => {
  const validRemoteForm: TunnelFormData = {
    tunnelType: "remote",
    bindHost: "0.0.0.0",
    bindPort: "9090",
    targetHost: "localhost",
    targetPort: "3000",
    label: "",
  };

  it("accepts a valid remote form", () => {
    const errors = validateTunnelForm(validRemoteForm);
    expect(Object.keys(errors)).toHaveLength(0);
  });

  it("rejects remote form with missing targetHost", () => {
    const form: TunnelFormData = { ...validRemoteForm, targetHost: "" };
    const errors = validateTunnelForm(form);
    expect(errors.targetHost).toBeTruthy();
  });
});

// ── Existing helpers — regression guard ──────────────────────────────────────

describe("getTunnelStateLabel", () => {
  it("returns Stopped for stopped state", () => {
    expect(getTunnelStateLabel("stopped")).toBe("Stopped");
  });

  it("returns Active for active state", () => {
    expect(getTunnelStateLabel({ active: { connections: 3 } })).toBe("Active");
  });

  it("returns Error for error state", () => {
    expect(getTunnelStateLabel({ error: { message: "port in use" } })).toBe("Error");
  });
});

describe("getActiveConnections", () => {
  it("returns 0 for non-active state", () => {
    expect(getActiveConnections("stopped")).toBe(0);
  });

  it("returns connection count for active state", () => {
    expect(getActiveConnections({ active: { connections: 7 } })).toBe(7);
  });
});

describe("getTunnelErrorMessage", () => {
  it("returns null for non-error state", () => {
    expect(getTunnelErrorMessage("stopped")).toBeNull();
  });

  it("returns message for error state", () => {
    expect(getTunnelErrorMessage({ error: { message: "port in use" } })).toBe("port in use");
  });
});

describe("getTunnelStateIndicator", () => {
  it("returns indicator-muted for stopped", () => {
    expect(getTunnelStateIndicator("stopped")).toBe("indicator-muted");
  });

  it("returns indicator-success for active", () => {
    expect(getTunnelStateIndicator({ active: { connections: 1 } })).toBe("indicator-success");
  });

  it("returns indicator-error for error", () => {
    expect(getTunnelStateIndicator({ error: { message: "fail" } })).toBe("indicator-error");
  });
});
