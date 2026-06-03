// features/proxmox/SnapshotConfirmDialog.tsx — Two-step snapshot confirm dialog
//
// Mirrors RmConfirmDialog. Two clicks required:
//   1. First click "arms" (shows Confirm + Cancel with warning text for rollback)
//   2. Second click (Confirm) fires onConfirm(snapshotName)
//   3. Cancel resets to unarmed
//
// Used for:
//   - Rollback: discards current container state (destructive, irreversible)
//   - Delete: permanently removes a snapshot

import { useState } from "react";
import { useI18n } from "../../lib/i18n";

type SnapshotAction = "rollback" | "delete";

interface SnapshotConfirmDialogProps {
  /** Whether this is a rollback or delete operation. */
  action: SnapshotAction;
  /** Snapshot name to operate on. Passed back to onConfirm. */
  snapshotName: string;
  /** Called when the user confirms the operation. */
  onConfirm: (snapshotName: string) => void;
  /** Called when the user cancels. */
  onCancel: () => void;
}

export function SnapshotConfirmDialog({
  action,
  snapshotName,
  onConfirm,
  onCancel,
}: SnapshotConfirmDialogProps) {
  const { t } = useI18n();
  const [armed, setArmed] = useState(false);

  const armKey =
    action === "rollback"
      ? "proxmox.snapshot.rollback.arm"
      : "proxmox.snapshot.delete.arm";

  const confirmKey =
    action === "rollback"
      ? "proxmox.snapshot.rollback.confirm"
      : "proxmox.snapshot.delete.confirm";

  const cancelKey =
    action === "rollback"
      ? "proxmox.snapshot.rollback.cancel"
      : "proxmox.snapshot.delete.cancel";

  function handleArmOrConfirm() {
    if (!armed) {
      setArmed(true);
    } else {
      onConfirm(snapshotName);
    }
  }

  function handleCancel() {
    setArmed(false);
    onCancel();
  }

  return (
    <div
      className="snapshot-confirm-dialog"
      role="group"
      aria-label={`${t(armKey)} snapshot ${snapshotName}`}
    >
      <span className="snapshot-confirm-name">
        <strong>{snapshotName}</strong>
      </span>
      {armed ? (
        <div className="snapshot-confirm-actions">
          {action === "rollback" && (
            <span className="snapshot-confirm-warning" role="alert">
              {t("proxmox.snapshot.rollback.warning")}
            </span>
          )}
          <button
            type="button"
            className="snapshot-confirm-btn snapshot-confirm-btn-danger"
            onClick={handleArmOrConfirm}
          >
            {t(confirmKey)}
          </button>
          <button
            type="button"
            className="snapshot-confirm-btn snapshot-confirm-btn-cancel"
            onClick={handleCancel}
          >
            {t(cancelKey)}
          </button>
        </div>
      ) : (
        <button
          type="button"
          className={`snapshot-confirm-btn snapshot-confirm-btn-arm${action === "rollback" ? " snapshot-confirm-btn-arm--warning" : ""}`}
          onClick={handleArmOrConfirm}
        >
          {t(armKey)}
        </button>
      )}
    </div>
  );
}
