// components/ui/Spinner.tsx — Loading spinner

interface SpinnerProps {
  size?: number;
}

export function Spinner({ size = 16 }: SpinnerProps) {
  return (
    <span
      className="spinner"
      style={{ width: size, height: size }}
      role="status"
      aria-label="Loading"
    />
  );
}
