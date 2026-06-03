// features/monitoring/Sparkline.test.tsx — TDD: dependency-free SVG sparkline

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { Sparkline } from "./Sparkline";

describe("Sparkline", () => {
  it("renders an SVG element", () => {
    const { container } = render(
      <Sparkline values={[10, 20, 30]} label="CPU" unit="%" />,
    );
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
  });

  it("renders a polyline when values are provided", () => {
    const { container } = render(
      <Sparkline values={[10, 20, 30]} label="CPU" unit="%" />,
    );
    const polyline = container.querySelector("polyline");
    expect(polyline).not.toBeNull();
  });

  it("polyline has one point per value", () => {
    const values = [10, 20, 30, 40, 50];
    const { container } = render(
      <Sparkline values={values} label="CPU" unit="%" />,
    );
    const polyline = container.querySelector("polyline")!;
    const points = polyline.getAttribute("points")!.trim().split(/\s+/);
    expect(points).toHaveLength(values.length);
  });

  it("aria-label contains the current (last) numeric value", () => {
    render(<Sparkline values={[10, 20, 75]} label="CPU" unit="%" />);
    // The accessible label must include the number — not just color-coded.
    const svg = screen.getByRole("img");
    expect(svg.getAttribute("aria-label")).toContain("75");
  });

  it("aria-label includes the unit", () => {
    render(<Sparkline values={[42]} label="RAM" unit="%" />);
    const svg = screen.getByRole("img");
    expect(svg.getAttribute("aria-label")).toContain("%");
  });

  it("renders without crash on empty values array", () => {
    const { container } = render(
      <Sparkline values={[]} label="CPU" unit="%" />,
    );
    // Should render SVG, no polyline (nothing to draw), no crash.
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelector("polyline")).toBeNull();
  });

  it("renders without crash on single value", () => {
    const { container } = render(
      <Sparkline values={[50]} label="CPU" unit="%" />,
    );
    expect(container.querySelector("polyline")).not.toBeNull();
  });

  it("respects custom width and height props", () => {
    const { container } = render(
      <Sparkline values={[10, 20]} label="CPU" unit="%" width={120} height={30} />,
    );
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("120");
    expect(svg.getAttribute("height")).toBe("30");
  });
});
