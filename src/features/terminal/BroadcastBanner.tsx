// features/terminal/BroadcastBanner.tsx — Broadcast mode indicator
//
// Full-width strip rendered at the top of .terminal-split when broadcastEnabled.
// Uses LAMPLIGHT --warning / --warning-wash tokens.
// a11y: role="status" aria-live="polite" — NOT color-only (explicit text).
// Clean-room design — no external broadcast library code referenced.

import { useI18n } from "../../lib/i18n";

interface BroadcastBannerProps {
  broadcastEnabled: boolean;
}

export function BroadcastBanner({ broadcastEnabled }: BroadcastBannerProps) {
  const { t } = useI18n();

  if (!broadcastEnabled) return null;

  return (
    <div
      className="terminal-broadcast-banner"
      role="status"
      aria-live="polite"
    >
      <span className="terminal-broadcast-banner-icon" aria-hidden="true">
        ⊕
      </span>
      <span className="terminal-broadcast-banner-text">
        {t("terminal.broadcastBanner")}
      </span>
    </div>
  );
}
