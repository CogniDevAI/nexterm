// features/monitoring/Sparkline.tsx — Dependency-free SVG sparkline
//
// Renders a <polyline> with normalized Y coordinates.
// Accessible: aria-label includes the current numeric value and unit.
// No external chart library — pure SVG with hand-rolled coordinate math.

interface SparklineProps {
  /** Data values to plot (most recent is last / rightmost). */
  values: number[];
  /** Human-readable label, e.g. "CPU" or "RAM". */
  label: string;
  /** Unit appended to the value in aria-label, e.g. "%" or "bps". */
  unit: string;
  /** SVG width in pixels. Default: 80. */
  width?: number;
  /** SVG height in pixels. Default: 24. */
  height?: number;
  /** Stroke color. Default: "currentColor". */
  color?: string;
}

export function Sparkline({
  values,
  label,
  unit,
  width = 80,
  height = 24,
  color = "currentColor",
}: SparklineProps) {
  const lastValue = values.length > 0 ? values[values.length - 1] : undefined;
  const ariaLabel =
    lastValue !== undefined
      ? `${label}: ${lastValue.toFixed(1)}${unit}`
      : `${label}: no data`;

  const points = buildPoints(values, width, height);

  return (
    <svg
      role="img"
      aria-label={ariaLabel}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      fill="none"
      overflow="visible"
    >
      {points !== null && (
        <polyline
          points={points}
          stroke={color}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      )}
    </svg>
  );
}

/**
 * Compute the SVG `points` attribute string from an array of values.
 *
 * Returns null when the array is empty (nothing to render).
 * Normalizes Y to the range [2, height-2] to avoid clipping at edges.
 */
function buildPoints(
  values: number[],
  width: number,
  height: number,
): string | null {
  if (values.length === 0) return null;

  const padding = 2;
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const range = maxVal - minVal || 1; // avoid divide-by-zero when all values equal

  const plotWidth = width;
  const plotHeight = height - padding * 2;

  return values
    .map((v, i) => {
      const x = values.length === 1 ? width / 2 : (i / (values.length - 1)) * plotWidth;
      // Invert Y: high value = top of SVG (low Y coordinate)
      const normalizedY = 1 - (v - minVal) / range;
      const y = padding + normalizedY * plotHeight;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}
