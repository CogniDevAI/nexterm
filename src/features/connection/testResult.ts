// features/connection/testResult.ts — Pure classifier for test_connection results
//
// Key security invariant: shouldSave is true if and only if r.authenticated is true.
// This is the single gate that prevents saving credentials to unverified hosts.

import type { TestConnectionResult } from "../../lib/types";

export type TestTone = "success" | "authFailed" | "untrusted" | "danger";

export interface TestClassification {
  tone: TestTone;
  /** True only when authentication was confirmed — the credential should be saved. */
  shouldSave: boolean;
}

/**
 * Classify a TestConnectionResult into a tone + save decision.
 *
 * Decision table:
 *   authenticated === true              → success   (shouldSave: true)
 *   !authenticated + hostKey=trusted    → authFailed (shouldSave: false)
 *   !authenticated + hostKey=unknown    → untrusted  (shouldSave: false)
 *   !authenticated + changed/revoked/? → danger     (shouldSave: false)
 */
export function classifyTestResult(r: TestConnectionResult): TestClassification {
  if (r.authenticated) {
    return { tone: "success", shouldSave: true };
  }
  switch (r.hostKey) {
    case "trusted":
      return { tone: "authFailed", shouldSave: false };
    case "unknown":
      return { tone: "untrusted", shouldSave: false };
    default:
      // changed, revoked, or any unexpected value
      return { tone: "danger", shouldSave: false };
  }
}
