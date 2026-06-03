// features/snippets/resolveSessionVars.test.ts
// TDD RED phase — resolves HOST/USERNAME/PORT/SESSION_ID from active session.

import { describe, it, expect } from "vitest";
import { resolveSessionVars, DYNAMIC_VAR_NAMES } from "./resolveSessionVars";
import type { SessionEntry } from "../../stores/sessionStore";

function makeSession(overrides?: Partial<SessionEntry>): SessionEntry {
  return {
    id: "sess-abc-123",
    profileId: "prof-1",
    profileName: "My Server",
    host: "10.0.0.1",
    username: "admin",
    port: 22,
    connectedAt: Date.now(),
    state: "connected" as const,
    terminals: [],
    activeTerminalId: "term-1",
    userId: "user-1",
    ...overrides,
  };
}

describe("resolveSessionVars — known dynamic vars", () => {
  it("resolves HOST from session.host", () => {
    const result = resolveSessionVars(makeSession({ host: "192.168.1.5" }));
    expect(result.HOST).toBe("192.168.1.5");
  });

  it("resolves USERNAME from session.username", () => {
    const result = resolveSessionVars(makeSession({ username: "root" }));
    expect(result.USERNAME).toBe("root");
  });

  it("resolves PORT as string from session.port", () => {
    const result = resolveSessionVars(makeSession({ port: 2222 }));
    expect(result.PORT).toBe("2222");
  });

  it("resolves SESSION_ID from session.id", () => {
    const result = resolveSessionVars(makeSession({ id: "sess-xyz" }));
    expect(result.SESSION_ID).toBe("sess-xyz");
  });

  it("returns all four dynamic var keys", () => {
    const result = resolveSessionVars(makeSession());
    expect(Object.keys(result)).toEqual(
      expect.arrayContaining(["HOST", "USERNAME", "PORT", "SESSION_ID"]),
    );
  });
});

describe("resolveSessionVars — no active session", () => {
  it("returns empty strings for all dynamic vars when session is null", () => {
    const result = resolveSessionVars(null);
    expect(result.HOST).toBe("");
    expect(result.USERNAME).toBe("");
    expect(result.PORT).toBe("");
    expect(result.SESSION_ID).toBe("");
  });

  it("does not throw when session is undefined", () => {
    expect(() => resolveSessionVars(undefined)).not.toThrow();
  });
});

describe("DYNAMIC_VAR_NAMES — exported constant set", () => {
  it("contains the four built-in var names", () => {
    expect(DYNAMIC_VAR_NAMES).toContain("HOST");
    expect(DYNAMIC_VAR_NAMES).toContain("USERNAME");
    expect(DYNAMIC_VAR_NAMES).toContain("PORT");
    expect(DYNAMIC_VAR_NAMES).toContain("SESSION_ID");
  });
});
