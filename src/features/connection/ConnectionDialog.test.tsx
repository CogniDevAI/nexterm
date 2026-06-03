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

// ─── Mutable store override for edit-mode tests ────────────────────────────
// The store mock below closes over this variable. Tests can swap it to inject
// a profile list for a specific render; reset to STABLE_PROFILES in beforeEach.
let currentMockProfiles: import("../../lib/types").ConnectionProfile[] = STABLE_PROFILES;

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
    profiles: currentMockProfiles,
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

// ─── Folder input ─────────────────────────────────────────────────────────────

describe("ConnectionDialog — folder field", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to empty so tests that don't need edit-mode start clean
    currentMockProfiles = STABLE_PROFILES;
    mockTauriInvoke.mockImplementation((cmd: string) => {
      if (cmd === "list_ssh_keys") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
  });

  it("renders a folder input in the Connection section", async () => {
    await act(async () => {
      render(<ConnectionDialog open onClose={vi.fn()} />);
    });

    // The folder input should be present (label key or input id)
    const folderInput = document.querySelector("#profile-folder");
    expect(folderInput).not.toBeNull();
  });

  it("folder value is empty for a new profile", async () => {
    await act(async () => {
      render(<ConnectionDialog open onClose={vi.fn()} />);
    });

    const folderInput = document.querySelector<HTMLInputElement>("#profile-folder");
    expect(folderInput).not.toBeNull();
    expect(folderInput?.value).toBe("");
  });

  it("typing a folder name updates the profile state and is saved", async () => {
    vi.mocked(STABLE_SAVE).mockResolvedValue("new-profile-id");

    // Re-mock the profile store with a save spy
    const { unmount } = await act(async () =>
      render(<ConnectionDialog open onClose={vi.fn()} />),
    );

    const folderInput = document.querySelector<HTMLInputElement>("#profile-folder");
    expect(folderInput).not.toBeNull();

    await act(async () => {
      if (folderInput) fireEvent.change(folderInput, { target: { value: "staging" } });
    });

    expect(folderInput?.value).toBe("staging");

    // Fill in required fields to pass validation
    await act(async () => {
      const nameInput = document.querySelector<HTMLInputElement>("#profile-name");
      const hostInput = document.querySelector<HTMLInputElement>("#profile-host");
      const userInput = document.querySelector<HTMLInputElement>(".cd-user-row-input");
      if (nameInput) fireEvent.change(nameInput, { target: { value: "My Server" } });
      if (hostInput) fireEvent.change(hostInput, { target: { value: "example.com" } });
      if (userInput) fireEvent.change(userInput, { target: { value: "admin" } });
    });

    const saveBtn = screen.getByText("connection.save");
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    await waitFor(() => {
      expect(STABLE_SAVE).toHaveBeenCalledWith(
        expect.objectContaining({ folder: "staging" }),
      );
    });

    unmount();
  });

  it("loads existing folder value when editing a profile", async () => {
    // Inject a profile with folder: "production" into the mutable store variable.
    // The vi.mock closure above reads currentMockProfiles at call time, so the
    // dialog's useEffect will find this profile when it calls profiles.find().
    const EDIT_PROFILE_ID = "edit-profile-abc";
    currentMockProfiles = [
      {
        id: EDIT_PROFILE_ID,
        name: "Prod Server",
        host: "prod.example.com",
        port: 22,
        users: [
          {
            id: "user-1",
            username: "deploy",
            authMethod: { type: "password" },
            isDefault: true,
          },
        ],
        folder: "production",
        startupCommands: [],
        tunnels: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    await act(async () => {
      render(
        <ConnectionDialog open onClose={vi.fn()} editProfileId={EDIT_PROFILE_ID} />,
      );
    });

    // The dialog should have loaded the existing profile's folder value
    const folderInput = document.querySelector<HTMLInputElement>("#profile-folder");
    expect(folderInput).not.toBeNull();
    expect(folderInput?.value).toBe("production");
  });
});

// ─── Keygen button ────────────────────────────────────────────────────────────

describe("ConnectionDialog — Generate new key button", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentMockProfiles = STABLE_PROFILES;
    mockTauriInvoke.mockImplementation((cmd: string) => {
      if (cmd === "list_ssh_keys") return Promise.resolve(MOCK_KEYS);
      return Promise.resolve(undefined);
    });
  });

  it("shows a 'Generate new key' button when publicKey auth is selected", async () => {
    await renderDialogAndWaitForKeys();
    await switchToPublicKeyAuth();

    await waitFor(() => {
      expect(
        screen.getByTitle("connection.keygen.hint"),
      ).toBeInTheDocument();
    });
  });
});
