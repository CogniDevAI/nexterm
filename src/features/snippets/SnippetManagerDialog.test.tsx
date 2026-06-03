// features/snippets/SnippetManagerDialog.test.tsx
// TDD RED phase — CRUD manager for the snippet library.

import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SnippetManagerDialog } from "./SnippetManagerDialog";
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

// ── Mock snippetStore ─────────────────────────────────────────
const { mockAddSnippet, mockUpdateSnippet, mockDeleteSnippet } =
  vi.hoisted(() => ({
    mockAddSnippet: vi.fn(),
    mockUpdateSnippet: vi.fn(),
    mockDeleteSnippet: vi.fn(),
  }));

vi.mock("../../stores/snippetStore", () => ({
  useSnippetStore: (selector: (s: { snippets: Snippet[]; addSnippet: unknown; updateSnippet: unknown; deleteSnippet: unknown }) => unknown) =>
    selector({
      snippets: [],
      addSnippet: mockAddSnippet,
      updateSnippet: mockUpdateSnippet,
      deleteSnippet: mockDeleteSnippet,
    }),
}));

const SNIPPET_A: Snippet = {
  id: "s1",
  name: "List files",
  template: "ls -la {{path:text:.}}",
  favorite: false,
  createdAt: 1000,
  updatedAt: 1000,
};

function renderManager(snippets: Snippet[] = [], onClose = vi.fn()) {
  return render(
    <SnippetManagerDialog open snippets={snippets} onClose={onClose} />,
  );
}

// ── Empty state ───────────────────────────────────────────────

describe("SnippetManagerDialog — empty state", () => {
  it("renders empty state message when no snippets", () => {
    renderManager([]);
    expect(screen.getByText(/snippets\.noSnippets/i)).toBeInTheDocument();
  });
});

// ── Add snippet ───────────────────────────────────────────────

describe("SnippetManagerDialog — add snippet", () => {
  it("renders the name and template inputs", () => {
    renderManager([]);
    expect(screen.getByPlaceholderText(/snippets\.namePlaceholder/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/snippets\.templatePlaceholder/i)).toBeInTheDocument();
  });

  it("clicking Save calls addSnippet with name and template", () => {
    renderManager([], vi.fn());
    const nameInput = screen.getByPlaceholderText(/snippets\.namePlaceholder/i);
    const templateInput = screen.getByPlaceholderText(/snippets\.templatePlaceholder/i);
    fireEvent.change(nameInput, { target: { value: "My snippet" } });
    fireEvent.change(templateInput, { target: { value: "echo {{msg}}" } });
    fireEvent.click(screen.getByRole("button", { name: /snippets\.save/i }));
    expect(mockAddSnippet).toHaveBeenCalledWith(
      expect.objectContaining({ name: "My snippet", template: "echo {{msg}}" }),
    );
  });
});

// ── List snippets ─────────────────────────────────────────────

describe("SnippetManagerDialog — list snippets", () => {
  it("renders snippet names when snippets are provided", () => {
    renderManager([SNIPPET_A]);
    expect(screen.getByText("List files")).toBeInTheDocument();
  });
});

// ── Delete snippet ────────────────────────────────────────────

describe("SnippetManagerDialog — delete snippet", () => {
  it("clicking delete calls deleteSnippet with snippet id", () => {
    renderManager([SNIPPET_A]);
    const deleteBtn = screen.getByRole("button", { name: /snippets\.delete/i });
    fireEvent.click(deleteBtn);
    expect(mockDeleteSnippet).toHaveBeenCalledWith(SNIPPET_A.id);
  });
});
