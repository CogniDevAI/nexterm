// testResult.test.ts — TDD: classifyTestResult pure classifier
//
// Tests are written FIRST (RED) to drive the implementation in testResult.ts.
// The key security invariant: shouldSave is true if and only if r.authenticated.

import { describe, it, expect } from "vitest";
import { classifyTestResult } from "./testResult";
import type { TestConnectionResult } from "../../lib/types";

describe("classifyTestResult", () => {
  it("success: authenticated=true + trusted → tone:success, shouldSave:true", () => {
    const r: TestConnectionResult = {
      authenticated: true,
      hostKey: "trusted",
      message: "Connection successful",
    };
    const cls = classifyTestResult(r);
    expect(cls.tone).toBe("success");
    expect(cls.shouldSave).toBe(true);
  });

  it("authFailed: authenticated=false + trusted → tone:authFailed, shouldSave:false", () => {
    const r: TestConnectionResult = {
      authenticated: false,
      hostKey: "trusted",
      message: "Server rejected authentication for user 'bob'",
    };
    const cls = classifyTestResult(r);
    expect(cls.tone).toBe("authFailed");
    expect(cls.shouldSave).toBe(false);
  });

  it("untrusted: authenticated=false + unknown → tone:untrusted, shouldSave:false", () => {
    const r: TestConnectionResult = {
      authenticated: false,
      hostKey: "unknown",
      message: "Host reachable, but its host key is not trusted yet.",
    };
    const cls = classifyTestResult(r);
    expect(cls.tone).toBe("untrusted");
    expect(cls.shouldSave).toBe(false);
  });

  it("danger: authenticated=false + changed → tone:danger, shouldSave:false", () => {
    const r: TestConnectionResult = {
      authenticated: false,
      hostKey: "changed",
      message: "Host key has CHANGED — possible MITM.",
    };
    const cls = classifyTestResult(r);
    expect(cls.tone).toBe("danger");
    expect(cls.shouldSave).toBe(false);
  });

  it("danger: authenticated=false + revoked → tone:danger, shouldSave:false", () => {
    const r: TestConnectionResult = {
      authenticated: false,
      hostKey: "revoked",
      message: "Host key is REVOKED.",
    };
    const cls = classifyTestResult(r);
    expect(cls.tone).toBe("danger");
    expect(cls.shouldSave).toBe(false);
  });

  it("danger: unexpected hostKey value → tone:danger, shouldSave:false", () => {
    const r = {
      authenticated: false,
      hostKey: "something-unexpected",
      message: "Unknown status",
    } as unknown as TestConnectionResult;
    const cls = classifyTestResult(r);
    expect(cls.tone).toBe("danger");
    expect(cls.shouldSave).toBe(false);
  });

  // Security invariant: shouldSave === r.authenticated in ALL cases
  it("invariant: shouldSave === r.authenticated for all cases", () => {
    const cases: TestConnectionResult[] = [
      { authenticated: true, hostKey: "trusted", message: "ok" },
      { authenticated: false, hostKey: "trusted", message: "auth fail" },
      { authenticated: false, hostKey: "unknown", message: "untrusted" },
      { authenticated: false, hostKey: "changed", message: "mitm" },
      { authenticated: false, hostKey: "revoked", message: "revoked" },
    ];
    for (const r of cases) {
      const cls = classifyTestResult(r);
      expect(cls.shouldSave).toBe(r.authenticated);
    }
  });
});
