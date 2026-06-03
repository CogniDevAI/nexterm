// features/monitoring/KillConfirmDialog.tsx — Two-step kill confirm widget
//
// Follows the same two-step pattern as SFTP delete confirm dialogs.
// First click "arms" the button; second click fires onKill.
// Cancel resets to the unarmed state.

import { useState } from "react";
import { useI18n } from "../../lib/i18n";

interface KillConfirmDialogProps {
  /** PID of the process to kill. */
  pid: number;
  /** Called when the user confirms the kill. */
  onKill: (pid: number) => void;
  /** Called when the user cancels. */
  onCancel: () => void;
}

export function KillConfirmDialog({ pid, onKill, onCancel }: KillConfirmDialogProps) {
  const { t } = useI18n();
  const [armed, setArmed] = useState(false);

  function handleArmOrConfirm() {
    if (!armed) {
      setArmed(true);
    } else {
      onKill(pid);
    }
  }

  function handleCancel() {
    setArmed(false);
    onCancel();
  }

  return (
    <div className="kill-confirm-dialog" role="group" aria-label={`Kill process ${pid}`}>
      <span className="kill-confirm-pid">
        {t("monitoring.kill.pid")}: <strong>{pid}</strong>
      </span>
      {armed ? (
        <div className="kill-confirm-actions">
          <button
            type="button"
            className="kill-confirm-btn kill-confirm-btn-danger"
            onClick={handleArmOrConfirm}
          >
            {t("monitoring.kill.confirm")}
          </button>
          <button
            type="button"
            className="kill-confirm-btn kill-confirm-btn-cancel"
            onClick={handleCancel}
          >
            {t("monitoring.kill.cancel")}
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="kill-confirm-btn kill-confirm-btn-arm"
          onClick={handleArmOrConfirm}
        >
          {t("monitoring.kill.arm")}
        </button>
      )}
    </div>
  );
}
