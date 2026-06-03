// features/docker/RmConfirmDialog.tsx — Two-step remove confirm dialog
//
// Mirrors KillConfirmDialog from monitoring. Two clicks required:
//   1. First click "arms" (shows Confirm + Cancel)
//   2. Second click (Confirm) fires onRm
//   3. Cancel resets to unarmed

import { useState } from "react";
import { useI18n } from "../../lib/i18n";

interface RmConfirmDialogProps {
  /** Container ID to remove. Passed back to onRm. */
  containerId: string;
  /** Container name for accessible display. */
  containerName: string;
  /** Called when the user confirms removal. */
  onRm: (containerId: string) => void;
  /** Called when the user cancels. */
  onCancel: () => void;
}

export function RmConfirmDialog({
  containerId,
  containerName,
  onRm,
  onCancel,
}: RmConfirmDialogProps) {
  const { t } = useI18n();
  const [armed, setArmed] = useState(false);

  function handleArmOrConfirm() {
    if (!armed) {
      setArmed(true);
    } else {
      onRm(containerId);
    }
  }

  function handleCancel() {
    setArmed(false);
    onCancel();
  }

  return (
    <div
      className="rm-confirm-dialog"
      role="group"
      aria-label={`Remove container ${containerName}`}
    >
      <span className="rm-confirm-name">
        {t("docker.rm.container")}: <strong>{containerName}</strong>
      </span>
      {armed ? (
        <div className="rm-confirm-actions">
          <button
            type="button"
            className="rm-confirm-btn rm-confirm-btn-danger"
            onClick={handleArmOrConfirm}
          >
            {t("docker.rm.confirm")}
          </button>
          <button
            type="button"
            className="rm-confirm-btn rm-confirm-btn-cancel"
            onClick={handleCancel}
          >
            {t("docker.rm.cancel")}
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="rm-confirm-btn rm-confirm-btn-arm"
          onClick={handleArmOrConfirm}
        >
          {t("docker.rm.arm")}
        </button>
      )}
    </div>
  );
}
