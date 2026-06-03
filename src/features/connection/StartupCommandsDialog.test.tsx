// Tests for StartupCommandsDialog.
// Written BEFORE the implementation (TDD RED phase).

import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
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

vi.mock("../../lib/i18n", () => ({
  useI18n: () => ({
    t: (k: string) => {
      const keys: Record<string, string> = {
        "startup.title": "Run startup commands?",
        "startup.subtitle":
          "These commands will run in the new session. Review before running.",
        "startup.run": "Run",
        "startup.cancel": "Skip",
      };
      return keys[k] ?? k;
    },
  }),
}));

import { StartupCommandsDialog } from "./StartupCommandsDialog";

const COMMANDS = ["ls -la", "uptime"];

describe("StartupCommandsDialog", () => {
  it("renders the list of commands as text", () => {
    render(
      <StartupCommandsDialog
        open
        commands={COMMANDS}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText("ls -la")).toBeInTheDocument();
    expect(screen.getByText("uptime")).toBeInTheDocument();
  });

  it("calls onConfirm when the Run button is clicked", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();

    render(
      <StartupCommandsDialog
        open
        commands={COMMANDS}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Run" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("calls onCancel when the Skip button is clicked", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();

    render(
      <StartupCommandsDialog
        open
        commands={COMMANDS}
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Skip" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("exposes an accessible dialog name via aria-labelledby", () => {
    render(
      <StartupCommandsDialog
        open
        commands={COMMANDS}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("dialog", { name: "Run startup commands?" }),
    ).toBeInTheDocument();
  });

  it("shows the profile name in the dialog when provided", () => {
    render(
      <StartupCommandsDialog
        open
        commands={COMMANDS}
        profileName="My Server"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText("My Server")).toBeInTheDocument();
  });
});
