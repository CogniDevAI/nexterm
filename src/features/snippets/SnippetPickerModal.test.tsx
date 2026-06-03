// features/snippets/SnippetPickerModal.test.tsx
// TDD RED phase — snippet picker with search + variable routing.

import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SnippetPickerModal } from "./SnippetPickerModal";
import type { Snippet } from "../../stores/snippetStore";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});

// ── Mock i18n ──────────────────────────────────────────────────
const { mockT } = vi.hoisted(() => ({
  mockT: vi.fn((key: string) => key),
}));
vi.mock("../../lib/i18n", () => ({
  useI18n: () => ({ t: mockT }),
}));

const SNIPPET_NO_VARS: Snippet = {
  id: "s1",
  name: "List files",
  template: "ls -la /tmp",
  favorite: false,
  createdAt: 1000,
  updatedAt: 1000,
};

const SNIPPET_WITH_VARS: Snippet = {
  id: "s2",
  name: "SSH connect",
  template: "ssh {{user}}@{{host}}",
  favorite: false,
  createdAt: 1001,
  updatedAt: 1001,
};

function renderPicker(
  snippets: Snippet[] = [SNIPPET_NO_VARS, SNIPPET_WITH_VARS],
  onPick = vi.fn(),
  onManage = vi.fn(),
  onClose = vi.fn(),
) {
  return render(
    <SnippetPickerModal
      open
      snippets={snippets}
      onPick={onPick}
      onManage={onManage}
      onClose={onClose}
    />,
  );
}

// ── Renders snippet list ──────────────────────────────────────

describe("SnippetPickerModal — renders list", () => {
  it("renders both snippet names", () => {
    renderPicker();
    expect(screen.getByText("List files")).toBeInTheDocument();
    expect(screen.getByText("SSH connect")).toBeInTheDocument();
  });

  it("renders empty state message when snippets list is empty", () => {
    renderPicker([]);
    expect(screen.getByText(/snippets\.empty/i)).toBeInTheDocument();
  });
});

// ── Search filter ─────────────────────────────────────────────

describe("SnippetPickerModal — search filter", () => {
  it("filters snippets by name", () => {
    renderPicker();
    const searchInput = screen.getByRole("searchbox");
    fireEvent.change(searchInput, { target: { value: "List" } });
    expect(screen.getByText("List files")).toBeInTheDocument();
    expect(screen.queryByText("SSH connect")).not.toBeInTheDocument();
  });

  it("filters snippets by template content", () => {
    renderPicker();
    const searchInput = screen.getByRole("searchbox");
    fireEvent.change(searchInput, { target: { value: "ssh" } });
    expect(screen.getByText("SSH connect")).toBeInTheDocument();
    expect(screen.queryByText("List files")).not.toBeInTheDocument();
  });

  it("shows all snippets when search is cleared", () => {
    renderPicker();
    const searchInput = screen.getByRole("searchbox");
    fireEvent.change(searchInput, { target: { value: "List" } });
    fireEvent.change(searchInput, { target: { value: "" } });
    expect(screen.getByText("List files")).toBeInTheDocument();
    expect(screen.getByText("SSH connect")).toBeInTheDocument();
  });
});

// ── Clicking snippet without user vars ───────────────────────

describe("SnippetPickerModal — no-variable snippet", () => {
  it("calls onPick directly (no variable modal) when snippet has no user vars", () => {
    const onPick = vi.fn();
    renderPicker([SNIPPET_NO_VARS], onPick);
    fireEvent.click(screen.getByText("List files"));
    expect(onPick).toHaveBeenCalledWith(SNIPPET_NO_VARS, []);
  });
});

// ── Clicking snippet with user vars ──────────────────────────

describe("SnippetPickerModal — snippet with variables", () => {
  it("calls onPick with the variable tokens when snippet has user vars", () => {
    const onPick = vi.fn();
    renderPicker([SNIPPET_WITH_VARS], onPick);
    fireEvent.click(screen.getByText("SSH connect"));
    expect(onPick).toHaveBeenCalledWith(
      SNIPPET_WITH_VARS,
      expect.arrayContaining([
        expect.objectContaining({ kind: "variable", name: "user" }),
        expect.objectContaining({ kind: "variable", name: "host" }),
      ]),
    );
  });
});
