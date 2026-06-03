// ConnectionDialog.test.tsx — TDD: key picker dropdown for publicKey auth
//
// Bug: privateKeyPath field is a free-text input — user has to know path.
//
// Fix: fetch available SSH keys via `list_ssh_keys`, show them in a dropdown,
// with a manual fallback for paths not in ~/.ssh.
//
// Root cause of the infinite-render trap:
// The `useEffect([open, editProfileId, profiles])` in ConnectionDialog uses
// `profiles` as a dep. A naive `() => ({ profiles: [] })` mock creates a NEW
// array reference on every render, triggering the effect on every render →
// infinite state updates. We use module-level stable constants to prevent this.

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

// ─── Stable mock data (module-level to avoid new-ref-per-render loop) ─────────
const MOCK_KEYS = [
  {
    path: "/Users/dev/.ssh/id_ed25519",
    keyType: "Ed25519",
    isEncrypted: false,
    comment: "dev@laptop",
  },
  {
    path: "/Users/dev/.ssh/id_rsa",
    keyType: "RSA",
    isEncrypted: true,
    comment: null,
  },
];
const STABLE_PROFILES: never[] = [];
const STABLE_SAVE = vi.fn().mockResolvedValue("profile-id-1");
const STABLE_STORE_CRED = vi.fn();

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockTauriInvoke = vi.fn();

vi.mock("../../lib/tauri", () => ({
  tauriInvoke: (...args: unknown[]) => mockTauriInvoke(...args),
  AppError: class AppError extends Error {
    constructor(_cmd: string, msg: string) {
      super(msg);
    }
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: vi.fn().mockImplementation(() => ({ onmessage: null })),
  invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/i18n", () => ({
  useI18n: () => ({ t: (k: string) => k }),
}));

vi.mock("../../stores/profileStore", () => ({
  useProfileStore: () => ({
    profiles: STABLE_PROFILES,
    saveProfile: STABLE_SAVE,
    storeCredential: STABLE_STORE_CRED,
  }),
}));

// Mock Dialog — jsdom doesn't implement showModal()
vi.mock("../../components/ui/Dialog", () => ({
  Dialog: ({
    open,
    children,
  }: {
    open: boolean;
    children: React.ReactNode;
    onClose: () => void;
    title: string;
    width?: string;
  }) => (open ? <div role="dialog">{children}</div> : null),
}));

// ─── Import after mocks ───────────────────────────────────────────────────────
import { ConnectionDialog } from "./ConnectionDialog";

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function renderDialogAndWaitForKeys() {
  let utils!: ReturnType<typeof render>;
  await act(async () => {
    utils = render(<ConnectionDialog open onClose={vi.fn()} />);
  });
  return utils;
}

async function switchToPublicKeyAuth() {
  // Find the key-icon auth button and click it
  const keyButton = screen.getAllByTitle("connection.publicKey")[0];
  if (!keyButton) throw new Error("publicKey auth button not found");
  await act(async () => {
    fireEvent.click(keyButton);
  });
  // Wait for the key list re-fetch on auth type switch
  await waitFor(() => {
    expect(mockTauriInvoke).toHaveBeenCalledWith("list_ssh_keys");
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ConnectionDialog — SSH key picker dropdown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: list_ssh_keys returns two keys
    mockTauriInvoke.mockImplementation((cmd: string) => {
      if (cmd === "list_ssh_keys") return Promise.resolve(MOCK_KEYS);
      return Promise.resolve(undefined);
    });
  });

  it("calls list_ssh_keys on dialog open", async () => {
    await renderDialogAndWaitForKeys();
    expect(mockTauriInvoke).toHaveBeenCalledWith("list_ssh_keys");
  });

  it("renders a dropdown with discovered keys when publicKey auth is selected", async () => {
    await renderDialogAndWaitForKeys();
    await switchToPublicKeyAuth();

    await waitFor(() => {
      // The dropdown should show the Ed25519 key
      expect(
        screen.getByRole("option", { name: /Ed25519.*dev@laptop/ }),
      ).toBeInTheDocument();
    });

    // RSA encrypted key
    expect(
      screen.getByRole("option", { name: /RSA.*encrypted/ }),
    ).toBeInTheDocument();
  });

  it("selecting a key from the dropdown sets privateKeyPath", async () => {
    await renderDialogAndWaitForKeys();
    await switchToPublicKeyAuth();

    const select = await waitFor(() =>
      screen.getByTestId("key-picker-select"),
    );

    await act(async () => {
      fireEvent.change(select, { target: { value: "/Users/dev/.ssh/id_ed25519" } });
    });

    expect((select as HTMLSelectElement).value).toBe("/Users/dev/.ssh/id_ed25519");
  });

  it("shows a manual path input as fallback (Other... option)", async () => {
    await renderDialogAndWaitForKeys();
    await switchToPublicKeyAuth();

    await waitFor(() => {
      const options = screen.getAllByRole("option");
      const hasOtherOption = options.some((o) =>
        o.textContent?.toLowerCase().includes("other") ||
        o.getAttribute("value") === "",
      );
      expect(hasOtherOption).toBe(true);
    });
  });

  it("falls back gracefully when list_ssh_keys fails", async () => {
    mockTauriInvoke.mockImplementation((cmd: string) => {
      if (cmd === "list_ssh_keys") return Promise.reject(new Error("permission denied"));
      return Promise.resolve(undefined);
    });

    // Should not throw — renders without keys
    await act(async () => {
      render(<ConnectionDialog open onClose={vi.fn()} />);
    });

    // Component should still render without crashing
    expect(document.querySelector(".cd-user-row")).not.toBeNull();
  });
});
