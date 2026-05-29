// HostKeyDialog.test.tsx
// TDD test for the host-key-type-changed security vulnerability fix.

import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import { HostKeyDialog } from "./HostKeyDialog";
import type { HostKeyVerificationRequest } from "../../lib/types";

// Mock the i18n module — all keys are returned as-is so we can query by key.
vi.mock("../../lib/i18n", () => ({
  useI18n: () => ({ t: (k: string) => k }),
}));

// Mock clipboard — jsdom does not implement it.
beforeAll(() => {
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

const changedWithOldKeyType: HostKeyVerificationRequest = {
  host: "example.com",
  port: 22,
  status: {
    type: "changed",
    oldFingerprint: "SHA256:AAAA",
    newFingerprint: "SHA256:BBBB",
    keyType: "ed25519",
    oldKeyType: "ssh-rsa", // <-- the dangerous branch
  },
};

const changedSameKeyType: HostKeyVerificationRequest = {
  host: "example.com",
  port: 22,
  status: {
    type: "changed",
    oldFingerprint: "SHA256:AAAA",
    newFingerprint: "SHA256:BBBB",
    keyType: "ed25519",
    // oldKeyType absent → same-type branch
  },
};

const unknownRequest: HostKeyVerificationRequest = {
  host: "example.com",
  port: 22,
  status: {
    type: "unknown",
    fingerprint: "SHA256:CCCC",
    keyType: "ed25519",
  },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("HostKeyDialog — security button hierarchy", () => {
  it(
    "Test A (THE HOLE — must be RED before fix): " +
      "different-key-type branch must have Disconnect as primary and Accept as danger-outline",
    () => {
      const spy = vi.fn();
      render(
        <HostKeyDialog open request={changedWithOldKeyType} onRespond={spy} />,
      );

      // Find buttons by their i18n key (returned as-is by our mock).
      const disconnectBtn = screen.getByRole("button", {
        name: "hostKey.disconnect",
      });
      const acceptBtn = screen.getByRole("button", {
        name: "hostKey.acceptNewKey",
      });

      // Disconnect must be the primary safe action.
      expect(disconnectBtn.className).toContain("hk-btn-primary");

      // Accept must be the destructive secondary — NOT primary.
      expect(acceptBtn.className).not.toContain("hk-btn-primary");
      expect(acceptBtn.className).toContain("hk-btn-danger-outline");
    },
  );

  it(
    "Test B (regression guard): " +
      "same-key-type branch must keep Disconnect as primary and Accept as danger-outline",
    () => {
      const spy = vi.fn();
      render(
        <HostKeyDialog open request={changedSameKeyType} onRespond={spy} />,
      );

      const disconnectBtn = screen.getByRole("button", {
        name: "hostKey.disconnect",
      });
      const acceptBtn = screen.getByRole("button", {
        name: "hostKey.acceptNewKey",
      });

      expect(disconnectBtn.className).toContain("hk-btn-primary");
      expect(acceptBtn.className).not.toContain("hk-btn-primary");
      expect(acceptBtn.className).toContain("hk-btn-danger-outline");
    },
  );

  it(
    "Test C (smoke — Unknown variant): " +
      "unknown variant renders and does not have a danger-primary Accept button",
    () => {
      const spy = vi.fn();
      render(<HostKeyDialog open request={unknownRequest} onRespond={spy} />);

      // Trust & Connect button must be present (primary for unknown is fine).
      const trustBtn = screen.getByRole("button", {
        name: "hostKey.trustConnect",
      });
      expect(trustBtn).toBeInTheDocument();
      expect(trustBtn.className).toContain("hk-btn-primary");

      // No "Accept New Key" button should exist in the unknown variant.
      expect(
        screen.queryByRole("button", { name: "hostKey.acceptNewKey" }),
      ).toBeNull();
    },
  );
});
