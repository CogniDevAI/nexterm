// PasswordStrength.test.tsx
// TDD test for the master-password strength affordance shown on the create path.
//
// Two surfaces are exercised:
//   1. The pure `estimateStrength` heuristic (length + character-class variety).
//   2. The <PasswordStrength /> component rendering the bar + label for the
//      weak vs. strong ends of the scale.

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PasswordStrength, estimateStrength } from "./PasswordStrength";

// Mock i18n — keys are returned as-is so we can assert on them directly.
vi.mock("../../lib/i18n", () => ({
  useI18n: () => ({ t: (k: string) => k }),
}));

// ── Pure heuristic ─────────────────────────────────────────────────────────

describe("estimateStrength", () => {
  it("returns score 0 for an empty password", () => {
    expect(estimateStrength("").score).toBe(0);
  });

  it("rates a 1-char password as weak (the silent-accept bug)", () => {
    const result = estimateStrength("a");
    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.level).toBe("weak");
  });

  it("rates a short single-class password as weak", () => {
    const result = estimateStrength("abcdef");
    expect(result.level).toBe("weak");
  });

  it("rates a medium mixed password as fair", () => {
    const result = estimateStrength("Abcd1234");
    expect(result.level).toBe("fair");
  });

  it("rates a long all-class password as strong", () => {
    const result = estimateStrength("Abcd1234!@#xyzPQR");
    expect(result.level).toBe("strong");
    expect(result.score).toBe(4);
  });

  it("rewards length even with limited variety", () => {
    const short = estimateStrength("aaaa");
    const long = estimateStrength("aaaaaaaaaaaaaaaaaaaa");
    expect(long.score).toBeGreaterThan(short.score);
  });

  it("rewards character-class variety at equal length", () => {
    const plain = estimateStrength("abcdefgh");
    const varied = estimateStrength("Abc1!def");
    expect(varied.score).toBeGreaterThan(plain.score);
  });
});

// ── Component ──────────────────────────────────────────────────────────────

describe("<PasswordStrength />", () => {
  it("renders nothing for an empty password", () => {
    const { container } = render(<PasswordStrength password="" />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the weak label and a weak-level bar for a trivial password", () => {
    render(<PasswordStrength password="a" />);
    expect(screen.getByText("vault.strength.weak")).toBeInTheDocument();
    const meter = screen.getByRole("progressbar");
    expect(meter.getAttribute("data-level")).toBe("weak");
  });

  it("shows the strong label and a strong-level bar for a robust password", () => {
    render(<PasswordStrength password="Abcd1234!@#xyzPQR" />);
    expect(screen.getByText("vault.strength.strong")).toBeInTheDocument();
    const meter = screen.getByRole("progressbar");
    expect(meter.getAttribute("data-level")).toBe("strong");
  });

  it("exposes accessible progressbar semantics", () => {
    render(<PasswordStrength password="Abcd1234" />);
    const meter = screen.getByRole("progressbar");
    expect(meter).toHaveAttribute("aria-valuemin", "0");
    expect(meter).toHaveAttribute("aria-valuemax", "4");
    expect(meter.getAttribute("aria-valuenow")).toBe(
      String(estimateStrength("Abcd1234").score),
    );
  });
});
