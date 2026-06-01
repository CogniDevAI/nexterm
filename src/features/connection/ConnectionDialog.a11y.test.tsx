// a11y invariant: ConnectionDialog wires its visible title (connection.newTitle /
// editTitle) to the Dialog via aria-labelledby, so the modal has an accessible
// name and getByRole('dialog', { name: <title> }) resolves.

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

// ─── Stable mock data (module-level to avoid new-ref-per-render loop) ─────────
const STABLE_PROFILES: never[] = [];
const STABLE_SAVE = vi.fn().mockResolvedValue("profile-id-1");
const STABLE_STORE_CRED = vi.fn();

const TITLES: Record<string, string> = {
  "connection.newTitle": "New Connection",
  "connection.editTitle": "Edit Profile",
};

const mockTauriInvoke = vi.fn();

vi.mock("../../lib/tauri", () => ({
  tauriInvoke: (...args: unknown[]) => mockTauriInvoke(...args),
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: vi.fn().mockImplementation(() => ({ onmessage: null })),
  invoke: vi.fn().mockResolvedValue(undefined),
}));

// Return real titles for the labelledby target; pass other keys through.
vi.mock("../../lib/i18n", () => ({
  useI18n: () => ({ t: (k: string) => TITLES[k] ?? k }),
}));

vi.mock("../../stores/profileStore", () => ({
  useProfileStore: () => ({
    profiles: STABLE_PROFILES,
    saveProfile: STABLE_SAVE,
    storeCredential: STABLE_STORE_CRED,
  }),
}));

// Use the REAL Dialog here (not a passthrough mock) so aria-labelledby is exercised.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close() {
    this.open = false;
  };
});

// ─── Import after mocks ───────────────────────────────────────────────────────
import { ConnectionDialog } from "./ConnectionDialog";

describe("ConnectionDialog — dialog accessible name", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTauriInvoke.mockImplementation((cmd: string) => {
      if (cmd === "list_ssh_keys") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
  });

  it("names the dialog via the visible title (new profile)", async () => {
    await act(async () => {
      render(<ConnectionDialog open onClose={vi.fn()} />);
    });

    expect(
      screen.getByRole("dialog", { name: "New Connection" }),
    ).toBeInTheDocument();
  });
});
