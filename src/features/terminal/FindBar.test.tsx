// FindBar.test.tsx — TDD: find-bar UI component for in-terminal search

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// Mock i18n
vi.mock("../../lib/i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      if (params) {
        return Object.entries(params).reduce(
          (acc, [k, v]) => acc.replace(`{${k}}`, String(v)),
          key,
        );
      }
      return key;
    },
  }),
}));

import { FindBar } from "./FindBar";

function renderFindBar(overrides?: Partial<React.ComponentProps<typeof FindBar>>) {
  const defaults = {
    query: "",
    caseSensitive: false,
    matchCurrent: 0,
    matchTotal: 0,
    onQueryChange: vi.fn(),
    onToggleCase: vi.fn(),
    onPrev: vi.fn(),
    onNext: vi.fn(),
    onClose: vi.fn(),
  };
  return render(<FindBar {...defaults} {...overrides} />);
}

describe("FindBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a search input", () => {
    renderFindBar();
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("shows the query value in the input", () => {
    renderFindBar({ query: "hello" });
    expect(screen.getByRole("textbox")).toHaveValue("hello");
  });

  it("calls onQueryChange when user types", () => {
    const onQueryChange = vi.fn();
    renderFindBar({ onQueryChange });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "foo" } });
    expect(onQueryChange).toHaveBeenCalledWith("foo");
  });

  it("renders prev and next buttons", () => {
    renderFindBar();
    // Both navigation buttons should be present
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBeGreaterThanOrEqual(3); // prev, next, close (+ optional case)
  });

  it("calls onPrev when prev button is clicked", () => {
    const onPrev = vi.fn();
    renderFindBar({ onPrev, query: "x", matchTotal: 3, matchCurrent: 1 });
    const prevBtn = screen.getByTitle("terminal.find.prevMatch");
    fireEvent.click(prevBtn);
    expect(onPrev).toHaveBeenCalledTimes(1);
  });

  it("calls onNext when next button is clicked", () => {
    const onNext = vi.fn();
    renderFindBar({ onNext, query: "x", matchTotal: 3, matchCurrent: 1 });
    const nextBtn = screen.getByTitle("terminal.find.nextMatch");
    fireEvent.click(nextBtn);
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when close button is clicked", () => {
    const onClose = vi.fn();
    renderFindBar({ onClose });
    const closeBtn = screen.getByTitle("terminal.find.closeSearch");
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when Escape is pressed in the input", () => {
    const onClose = vi.fn();
    renderFindBar({ onClose });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onNext when Enter is pressed in the input", () => {
    const onNext = vi.fn();
    renderFindBar({ onNext });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("calls onPrev when Shift+Enter is pressed in the input", () => {
    const onPrev = vi.fn();
    renderFindBar({ onPrev });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", shiftKey: true });
    expect(onPrev).toHaveBeenCalledTimes(1);
  });

  it("shows match count when there are matches", () => {
    renderFindBar({ query: "test", matchTotal: 5, matchCurrent: 2 });
    // The count label should appear
    expect(screen.getByText(/terminal\.find\.matchCount/)).toBeInTheDocument();
  });

  it("shows no-matches label when query has no matches", () => {
    renderFindBar({ query: "nomatch", matchTotal: 0, matchCurrent: 0 });
    expect(screen.getByText("terminal.find.noMatches")).toBeInTheDocument();
  });

  it("disables prev/next buttons when there are no matches", () => {
    renderFindBar({ query: "x", matchTotal: 0, matchCurrent: 0 });
    const prevBtn = screen.getByTitle("terminal.find.prevMatch");
    const nextBtn = screen.getByTitle("terminal.find.nextMatch");
    expect(prevBtn).toBeDisabled();
    expect(nextBtn).toBeDisabled();
  });

  it("calls onToggleCase when case button is clicked", () => {
    const onToggleCase = vi.fn();
    renderFindBar({ onToggleCase });
    const caseBtn = screen.getByTitle("terminal.find.caseToggle");
    fireEvent.click(caseBtn);
    expect(onToggleCase).toHaveBeenCalledTimes(1);
  });

  it("marks case button as active when caseSensitive is true", () => {
    renderFindBar({ caseSensitive: true });
    const caseBtn = screen.getByTitle("terminal.find.caseToggle");
    expect(caseBtn).toHaveAttribute("aria-pressed", "true");
  });
});
