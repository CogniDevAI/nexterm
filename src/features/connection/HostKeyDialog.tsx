// features/connection/HostKeyDialog.tsx — Host key verification modal
//
// Two distinct UX modes:
// - UNKNOWN (first connection): friendly, simple, details collapsed
// - CHANGED (key mismatch): red warning, dangerous, safe default is "Disconnect"

import { useCallback, useState } from "react";
import { useI18n } from "../../lib/i18n";
import type {
  HostKeyVerificationRequest,
  HostKeyVerificationResponse,
} from "../../lib/types";

interface HostKeyDialogProps {
  open: boolean;
  request: HostKeyVerificationRequest | null;
  onRespond: (response: HostKeyVerificationResponse) => void;
}

/* ─── Icons (inline SVG to avoid deps) ───────────────── */

function ShieldCheckIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

function ShieldAlertIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        transition: "transform 150ms ease",
        transform: open ? "rotate(90deg)" : "rotate(0deg)",
      }}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </svg>
  );
}

/* ─── Fingerprint display with copy ──────────────────── */

function FingerprintValue({ value, label }: { value: string; label?: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [value]);

  return (
    <div className="hk-fp-row">
      {label && <span className="hk-fp-label">{label}</span>}
      <div className="hk-fp-value-wrap">
        <code className="hk-fp-value">{value}</code>
        <button
          className="hk-fp-copy"
          onClick={handleCopy}
          title="Copy"
          type="button"
        >
          {copied ? (
            <span className="hk-fp-copied">{t("hostKey.copied")}</span>
          ) : (
            <CopyIcon />
          )}
        </button>
      </div>
    </div>
  );
}

/* ─── Main Component ─────────────────────────────────── */

export function HostKeyDialog({ open, request, onRespond }: HostKeyDialogProps) {
  const { t } = useI18n();
  const [detailsOpen, setDetailsOpen] = useState(false);

  if (!request || !open) return null;

  const isChanged = request.status.type === "changed";
  const hostStr = request.port === 22
    ? request.host
    : `${request.host}:${request.port}`;

  // ─── CHANGED: Dangerous flow ────────────────────────
  if (isChanged && request.status.type === "changed") {
    return (
      <div className="hk-overlay" onClick={() => onRespond("reject")}>
        <div className="hk-modal hk-modal-danger" onClick={(e) => e.stopPropagation()}>
          {/* Header */}
          <div className="hk-header hk-header-danger">
            <div className="hk-header-icon hk-icon-danger">
              <ShieldAlertIcon />
            </div>
            <div className="hk-header-text">
              <h3 className="hk-title">{t("hostKey.changedTitle")}</h3>
            </div>
          </div>

          {/* Warning banner */}
          <div className="hk-danger-banner">
            <p className="hk-danger-text">
              {t("hostKey.changedWarning", { host: hostStr })}
            </p>
            <p className="hk-danger-advice">
              {t("hostKey.changedAdvice")}
            </p>
          </div>

          {/* Fingerprint comparison */}
          <div className="hk-body">
            <div className="hk-info-card">
              <div className="hk-info-row">
                <span className="hk-info-label">{t("hostKey.host")}</span>
                <code className="hk-info-value">{hostStr}</code>
              </div>
              <div className="hk-info-row">
                <span className="hk-info-label">{t("hostKey.keyType")}</span>
                <code className="hk-info-value">{request.status.keyType}</code>
              </div>
            </div>

            <div className="hk-fp-comparison">
              <FingerprintValue
                label={t("hostKey.oldFingerprint")}
                value={request.status.oldFingerprint}
              />
              <FingerprintValue
                label={t("hostKey.newFingerprint")}
                value={request.status.newFingerprint}
              />
            </div>
          </div>

          {/* Actions — safe default is Disconnect */}
          <div className="hk-actions">
            <button
              className="hk-btn hk-btn-danger-outline"
              onClick={() => onRespond("acceptAndSave")}
              type="button"
            >
              {t("hostKey.acceptNewKey")}
            </button>
            <button
              className="hk-btn hk-btn-primary"
              onClick={() => onRespond("reject")}
              type="button"
            >
              {t("hostKey.disconnect")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── UNKNOWN: Friendly first-connection flow ────────
  return (
    <div className="hk-overlay" onClick={() => onRespond("reject")}>
      <div className="hk-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="hk-header">
          <div className="hk-header-icon hk-icon-accent">
            <ShieldCheckIcon />
          </div>
          <div className="hk-header-text">
            <h3 className="hk-title">{t("hostKey.unknownTitle")}</h3>
            <p className="hk-subtitle">
              {t("hostKey.unknownMessage", { host: hostStr })}
            </p>
          </div>
        </div>

        {/* Host info — always visible */}
        <div className="hk-body">
          <div className="hk-info-card">
            <div className="hk-info-row">
              <span className="hk-info-label">{t("hostKey.host")}</span>
              <code className="hk-info-value">{hostStr}</code>
            </div>
            {request.status.type === "unknown" && request.status.keyType && (
              <div className="hk-info-row">
                <span className="hk-info-label">{t("hostKey.keyType")}</span>
                <code className="hk-info-value">{request.status.keyType}</code>
              </div>
            )}
          </div>

          {/* Collapsible details */}
          {request.status.type === "unknown" && (
            <div className="hk-details">
              <button
                className="hk-details-toggle"
                onClick={() => setDetailsOpen(!detailsOpen)}
                type="button"
              >
                <ChevronIcon open={detailsOpen} />
                <span>{t("hostKey.details")}</span>
              </button>
              {detailsOpen && (
                <div className="hk-details-content">
                  <FingerprintValue value={request.status.fingerprint} />
                </div>
              )}
            </div>
          )}
        </div>

        {/* Actions — Trust & Connect is primary */}
        <div className="hk-actions">
          <button
            className="hk-btn hk-btn-ghost"
            onClick={() => onRespond("reject")}
            type="button"
          >
            {t("hostKey.cancel")}
          </button>
          <div className="hk-actions-right">
            <button
              className="hk-btn hk-btn-link"
              onClick={() => onRespond("accept")}
              type="button"
            >
              {t("hostKey.connectWithoutSaving")}
            </button>
            <button
              className="hk-btn hk-btn-primary"
              onClick={() => onRespond("acceptAndSave")}
              type="button"
            >
              {t("hostKey.trustConnect")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
