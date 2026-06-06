// features/vault/PasswordStrength.tsx — Master-password strength affordance
//
// Dependency-free strength estimator (no zxcvbn). The heuristic blends three
// cheap signals into a 0-4 score:
//   1. Length buckets (the dominant factor for real-world resistance).
//   2. Character-class variety (lower, upper, digit, symbol).
//   3. A coarse entropy floor so a long-but-single-class password still beats
//      a short mixed one.
//
// The pure `estimateStrength` function is exported so it can be unit-tested in
// isolation; the component is a thin, accessible renderer on top of it.

import { useI18n } from "../../lib/i18n";

export type StrengthLevel = "weak" | "fair" | "strong";

export interface StrengthResult {
  /** Discrete score in the inclusive range 0-4. */
  score: number;
  /** Bucketed qualitative level derived from the score. */
  level: StrengthLevel;
}

const MAX_SCORE = 4;

/**
 * Estimate password strength on a 0-4 scale without external dependencies.
 *
 * The score is the sum of a length contribution and a variety contribution,
 * clamped to [0, 4]. Empty input is always 0.
 */
export function estimateStrength(password: string): StrengthResult {
  if (!password) return { score: 0, level: "weak" };

  const length = password.length;

  // ── Length contribution (0-3) ──
  // Tuned so a single character can never escape the weak band.
  let lengthPoints = 0;
  if (length >= 6) lengthPoints += 1;
  if (length >= 10) lengthPoints += 1;
  if (length >= 14) lengthPoints += 1;

  // ── Variety contribution (0-2) ──
  const classes =
    (/[a-z]/.test(password) ? 1 : 0) +
    (/[A-Z]/.test(password) ? 1 : 0) +
    (/[0-9]/.test(password) ? 1 : 0) +
    (/[^a-zA-Z0-9]/.test(password) ? 1 : 0);
  let varietyPoints = 0;
  if (classes >= 2) varietyPoints += 1;
  if (classes >= 3) varietyPoints += 1;

  // ── Coarse entropy floor ──
  // log2(poolSize ^ length) approximates the search space. A very low estimate
  // caps the score so short passwords cannot reach the top bands via variety
  // alone.
  const poolSize =
    (/[a-z]/.test(password) ? 26 : 0) +
    (/[A-Z]/.test(password) ? 26 : 0) +
    (/[0-9]/.test(password) ? 10 : 0) +
    (/[^a-zA-Z0-9]/.test(password) ? 32 : 0);
  const entropy = poolSize > 0 ? length * Math.log2(poolSize) : 0;

  let score = lengthPoints + varietyPoints;
  if (entropy < 28) score = Math.min(score, 1);
  else if (entropy < 60) score = Math.min(score, 2);

  score = Math.max(0, Math.min(MAX_SCORE, score));

  const level: StrengthLevel = score <= 1 ? "weak" : score <= 2 ? "fair" : "strong";

  return { score, level };
}

interface PasswordStrengthProps {
  password: string;
}

const LEVEL_LABEL_KEY = {
  weak: "vault.strength.weak",
  fair: "vault.strength.fair",
  strong: "vault.strength.strong",
} as const;

/**
 * Renders an accessible strength meter (segmented bar + label) for the given
 * password. Renders nothing when the password is empty so the create form stays
 * uncluttered until the user starts typing.
 */
export function PasswordStrength({ password }: PasswordStrengthProps) {
  const { t } = useI18n();

  if (!password) return null;

  const { score, level } = estimateStrength(password);

  return (
    <div className="pw-strength" data-level={level}>
      <div
        className="pw-strength-track"
        role="progressbar"
        data-level={level}
        aria-valuemin={0}
        aria-valuemax={MAX_SCORE}
        aria-valuenow={score}
        aria-label={t("vault.strength.label")}
      >
        {Array.from({ length: MAX_SCORE }, (_, i) => (
          <span
            key={i}
            className="pw-strength-segment"
            data-filled={i < score ? "true" : "false"}
          />
        ))}
      </div>
      <span className="pw-strength-label" data-level={level}>
        {t(LEVEL_LABEL_KEY[level])}
      </span>
    </div>
  );
}
