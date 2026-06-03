// KeygenDialog.test.tsx — TDD tests for in-app SSH key generation dialog
//
// Written BEFORE the component (RED phase).

import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// jsdom does not implement native <dialog> modal API
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close() {
    this.open = false;
  };
});

// ─── Mocks ────────────────────────────────────────────────

const mockTauriInvoke = vi.fn();

vi.mock("../../lib/tauri", () => ({
  tauriInvoke: (...args: unknown[]) => mockTauriInvoke(...args),
  AppError: class AppError extends Error {
    constructor(_cmd: string, msg: string) {
      super(msg);
    }
  },
}));

vi.mock("../../lib/i18n", () => ({
  useI18n: () => ({
    t: (k: string) => {
      const keys: Record<string, string> = {
        "keygen.title": "Generate SSH Key",
        "keygen.algorithm": "Algorithm",
        "keygen.comment": "Comment",
        "keygen.commentPlaceholder": "user@hostname",
        "keygen.passphrase": "Passphrase",
        "keygen.passphrasePlaceholder": "Optional — leave blank for no passphrase",
        "keygen.filename": "Filename",
        "keygen.filenamePlaceholder": "e.g. id_ed25519",
        "keygen.generate": "Generate",
        "keygen.generating": "Generating…",
        "keygen.cancel": "Cancel",
        "keygen.publicKeyLabel":
          "Public key — add this to your server's ~/.ssh/authorized_keys",
        "keygen.copyPublicKey": "Copy",
        "keygen.copied": "Copied!",
        "keygen.useThisKey": "Use this key",
        "keygen.done": "Done",
        "keygen.errorAlreadyExists": "Key already exists",
        "keygen.hint": "Generate new key",
      };
      return keys[k] ?? k;
    },
  }),
}));

vi.mock("../../components/ui/Dialog", () => ({
  Dialog: ({
    open,
    children,
  }: {
    open: boolean;
    children: React.ReactNode;
    onClose: () => void;
    title: string;
  }) => (open ? <div role="dialog">{children}</div> : null),
}));

import { KeygenDialog } from "./KeygenDialog";

// ─── Tests ────────────────────────────────────────────────

describe("KeygenDialog", () => {
  it("renders algorithm options with Ed25519 selected by default", () => {
    render(
      <KeygenDialog
        open
        onClose={vi.fn()}
        onKeyGenerated={vi.fn()}
      />,
    );

    const select = screen.getByLabelText("Algorithm") as HTMLSelectElement;
    expect(select).toBeInTheDocument();
    expect(select.value).toBe("ed25519");

    // All algorithm options must be present
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toContain("ed25519");
    expect(options).toContain("rsa2048");
    expect(options).toContain("rsa4096");
    expect(options).toContain("ecdsaP256");
    expect(options).toContain("ecdsaP384");
  });

  it("calls generate_ssh_key with correct params when Generate is clicked", async () => {
    const user = userEvent.setup();
    const mockResult = {
      publicKeyOpenssh: "ssh-ed25519 AAAA test@host",
      privateKeyPath: "/home/user/.ssh/id_ed25519_test",
      publicKeyPath: "/home/user/.ssh/id_ed25519_test.pub",
    };
    mockTauriInvoke.mockResolvedValueOnce(mockResult);

    render(
      <KeygenDialog
        open
        onClose={vi.fn()}
        onKeyGenerated={vi.fn()}
      />,
    );

    // Fill filename (required)
    const filenameInput = screen.getByLabelText("Filename");
    await user.clear(filenameInput);
    await user.type(filenameInput, "id_ed25519_test");

    await user.click(screen.getByRole("button", { name: "Generate" }));

    await waitFor(() => {
      expect(mockTauriInvoke).toHaveBeenCalledWith("generate_ssh_key", {
        algorithm: "ed25519",
        comment: expect.any(String),
        passphrase: null,
        filename: "id_ed25519_test",
      });
    });
  });

  it("shows the public key in a code block after successful generation", async () => {
    const user = userEvent.setup();
    const mockResult = {
      publicKeyOpenssh: "ssh-ed25519 AAAA test@host",
      privateKeyPath: "/home/user/.ssh/id_ed25519",
      publicKeyPath: "/home/user/.ssh/id_ed25519.pub",
    };
    mockTauriInvoke.mockResolvedValueOnce(mockResult);

    render(
      <KeygenDialog
        open
        onClose={vi.fn()}
        onKeyGenerated={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Generate" }));

    await waitFor(() => {
      expect(screen.getByText("ssh-ed25519 AAAA test@host")).toBeInTheDocument();
    });
  });

  it("shows a Copy button after successful generation", async () => {
    const user = userEvent.setup();
    mockTauriInvoke.mockResolvedValueOnce({
      publicKeyOpenssh: "ssh-ed25519 AAAA copy@test",
      privateKeyPath: "/home/user/.ssh/id_test",
      publicKeyPath: "/home/user/.ssh/id_test.pub",
    });

    render(
      <KeygenDialog
        open
        onClose={vi.fn()}
        onKeyGenerated={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Generate" }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Copy" }),
      ).toBeInTheDocument();
    });
  });

  it("calls onKeyGenerated with the private key path when 'Use this key' is clicked", async () => {
    const user = userEvent.setup();
    const onKeyGenerated = vi.fn();
    const mockResult = {
      publicKeyOpenssh: "ssh-ed25519 AAAA use@test",
      privateKeyPath: "/home/user/.ssh/id_use_test",
      publicKeyPath: "/home/user/.ssh/id_use_test.pub",
    };
    mockTauriInvoke.mockResolvedValueOnce(mockResult);

    render(
      <KeygenDialog
        open
        onClose={vi.fn()}
        onKeyGenerated={onKeyGenerated}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Generate" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Use this key" })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Use this key" }));
    expect(onKeyGenerated).toHaveBeenCalledWith("/home/user/.ssh/id_use_test");
  });

  it("shows an error message when generation fails", async () => {
    const user = userEvent.setup();
    const { AppError } = await import("../../lib/tauri");
    mockTauriInvoke.mockRejectedValueOnce(
      new AppError("generate_ssh_key", "Key already exists: /home/user/.ssh/id_ed25519"),
    );

    render(
      <KeygenDialog
        open
        onClose={vi.fn()}
        onKeyGenerated={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Generate" }));

    await waitFor(() => {
      expect(
        screen.getByText(/Key already exists/i),
      ).toBeInTheDocument();
    });
  });

  it("calls onClose when Cancel button is clicked", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(
      <KeygenDialog
        open
        onClose={onClose}
        onKeyGenerated={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
