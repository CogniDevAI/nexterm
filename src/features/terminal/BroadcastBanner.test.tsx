// features/terminal/BroadcastBanner.test.tsx — TDD: WU-4 RED phase
//
// Tests for the BroadcastBanner indicator component.

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { BroadcastBanner } from "./BroadcastBanner";

vi.mock("../../lib/i18n", () => ({
  useI18n: () => ({ t: (k: string) => k }),
}));

describe("BroadcastBanner", () => {
  it("renders nothing when broadcastEnabled is false", () => {
    const { container } = render(<BroadcastBanner broadcastEnabled={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the banner when broadcastEnabled is true", () => {
    render(<BroadcastBanner broadcastEnabled={true} />);
    const banner = document.querySelector(".terminal-broadcast-banner");
    expect(banner).not.toBeNull();
  });

  it("displays the broadcast banner i18n key text", () => {
    render(<BroadcastBanner broadcastEnabled={true} />);
    // The mock returns the key itself — check the key is rendered
    expect(screen.getByText("terminal.broadcastBanner")).toBeInTheDocument();
  });

  it("has role='status' for a11y", () => {
    render(<BroadcastBanner broadcastEnabled={true} />);
    const banner = screen.getByRole("status");
    expect(banner).toBeInTheDocument();
  });

  it("has aria-live='polite' on the banner element", () => {
    render(<BroadcastBanner broadcastEnabled={true} />);
    const banner = screen.getByRole("status");
    expect(banner).toHaveAttribute("aria-live", "polite");
  });

  it("contains a text element that is NOT icon-only (explicit text present)", () => {
    render(<BroadcastBanner broadcastEnabled={true} />);
    const banner = document.querySelector(".terminal-broadcast-banner");
    expect(banner?.textContent).toBeTruthy();
    // Must have more than just an icon glyph — text content should be non-empty string
    expect((banner?.textContent?.trim().length ?? 0)).toBeGreaterThan(0);
  });
});
