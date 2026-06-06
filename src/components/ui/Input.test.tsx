// Input.test.tsx
// Smoke test for the optional password-reveal affordance on the shared Input.

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Input } from "./Input";

describe("Input — password reveal toggle", () => {
  it("does not render a reveal button by default", () => {
    render(<Input type="password" value="secret" onChange={() => {}} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders a reveal button and toggles the input type when enabled", () => {
    render(
      <Input
        type="password"
        value="secret"
        onChange={() => {}}
        reveal
        revealLabel="Show password"
        hideLabel="Hide password"
      />,
    );

    const input = screen.getByDisplayValue("secret");
    expect(input).toHaveAttribute("type", "password");

    const toggle = screen.getByRole("button", { name: "Show password" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(toggle);
    expect(input).toHaveAttribute("type", "text");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle).toHaveAttribute("aria-label", "Hide password");

    fireEvent.click(toggle);
    expect(input).toHaveAttribute("type", "password");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps the reveal button out of the tab order", () => {
    render(
      <Input
        type="password"
        value="secret"
        onChange={() => {}}
        reveal
        revealLabel="Show password"
        hideLabel="Hide password"
      />,
    );
    expect(screen.getByRole("button")).toHaveAttribute("tabindex", "-1");
  });
});
