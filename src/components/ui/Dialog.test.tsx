// a11y invariant: Dialog exposes role="dialog" and derives its accessible name
// from an aria-labelledby (and/or aria-label) prop, so assistive tech and
// getByRole('dialog', { name }) can identify it.

import { describe, it, expect, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import { Dialog } from "./Dialog";

// jsdom does not implement the native <dialog> modal API.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close() {
    this.open = false;
  };
});

describe("Dialog — accessible name", () => {
  it("exposes role=dialog and is named by aria-labelledby", () => {
    render(
      <Dialog
        open
        onClose={() => {}}
        title=""
        aria-labelledby="dlg-title"
      >
        <h3 id="dlg-title">Edit Profile</h3>
      </Dialog>,
    );

    const dialog = screen.getByRole("dialog", { name: "Edit Profile" });
    expect(dialog).toBeInTheDocument();
  });

  it("accepts an aria-label fallback", () => {
    render(
      <Dialog open onClose={() => {}} title="" aria-label="Settings">
        <div>body</div>
      </Dialog>,
    );

    expect(
      screen.getByRole("dialog", { name: "Settings" }),
    ).toBeInTheDocument();
  });
});
