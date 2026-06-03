// features/sftp/ConflictDialog.tsx — SFTP transfer conflict resolution dialog
//
// Shown when a transfer destination already exists. The default/safe action
// is Skip (autofocused). Overwrite is danger-styled to prevent accidental
// data loss. Supports single-file (Skip / Overwrite / Skip All / Overwrite All)
// and batch confirmation flows.
//
// Design follows NexTerm's own Dialog component pattern — no external
// conflict-resolution framework reused.

import { useEffect, useRef } from "react";
import { Dialog } from "../../components/ui/Dialog";
import { useI18n } from "../../lib/i18n";
import type { ConflictInfo, ConflictResolution } from "../../lib/types";

// ─── Helpers ────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatTimestamp(ts: number | null): string {
  if (ts === null) return "—";
  return new Date(ts * 1000).toLocaleString();
}

// ─── Props ───────────────────────────────────────────────

interface ConflictDialogProps {
  open: boolean;
  conflict: ConflictInfo | null;
  onResolve: (resolution: ConflictResolution) => void;
  onClose: () => void;
}

// ─── Component ──────────────────────────────────────────

export function ConflictDialog({
  open,
  conflict,
  onResolve,
  onClose,
}: ConflictDialogProps) {
  const { t } = useI18n();
  const skipRef = useRef<HTMLButtonElement>(null);

  // Auto-focus the Skip button (safe default) when the dialog opens.
  useEffect(() => {
    if (open && skipRef.current) {
      skipRef.current.focus();
    }
  }, [open]);

  if (!open || !conflict) return null;

  const titleId = "conflict-dialog-title";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title=""
      width="500px"
      aria-labelledby={titleId}
    >
      {/* Custom header */}
      <div className="cd-header">
        <h3 className="cd-title" id={titleId}>
          {t("sftp.conflict.title")}
        </h3>
        <button className="dialog-close" onClick={onClose}>
          &times;
        </button>
      </div>

      <div className="cd-section-content">
        <p className="cd-subtitle">{t("sftp.conflict.subtitle")}</p>

        {/* File info table */}
        <div className="conflict-info">
          <div className="conflict-info-row">
            <span className="conflict-info-label">{t("sftp.conflict.fileName")}</span>
            <span className="conflict-info-value conflict-info-filename">
              {conflict.fileName}
            </span>
          </div>
          <div className="conflict-info-row">
            <span className="conflict-info-label">{t("sftp.conflict.existingSize")}</span>
            <span className="conflict-info-value">{formatBytes(conflict.existingSize)}</span>
          </div>
          <div className="conflict-info-row">
            <span className="conflict-info-label">{t("sftp.conflict.incomingSize")}</span>
            <span className="conflict-info-value">{formatBytes(conflict.incomingSize)}</span>
          </div>
          {conflict.existingModified !== null && (
            <div className="conflict-info-row">
              <span className="conflict-info-label">
                {t("sftp.conflict.existingModified")}
              </span>
              <span className="conflict-info-value">
                {formatTimestamp(conflict.existingModified)}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="cd-actions">
        {/* Skip All — secondary safe */}
        <button
          className="cd-btn cd-btn-secondary"
          onClick={() => onResolve("skip_all")}
        >
          {t("sftp.conflict.skipAll")}
        </button>

        {/* Overwrite All — danger */}
        <button
          className="cd-btn cd-btn-danger"
          data-variant="danger"
          onClick={() => onResolve("overwrite_all")}
        >
          {t("sftp.conflict.overwriteAll")}
        </button>

        {/* Overwrite — danger */}
        <button
          className="cd-btn cd-btn-danger"
          data-variant="danger"
          onClick={() => onResolve("overwrite")}
        >
          {t("sftp.conflict.overwrite")}
        </button>

        {/* Skip — primary safe, autofocused */}
        <button
          ref={skipRef}
          className="cd-btn cd-btn-primary"
          data-autofocus="true"
          autoFocus
          onClick={() => onResolve("skip")}
        >
          {t("sftp.conflict.skip")}
        </button>
      </div>
    </Dialog>
  );
}
