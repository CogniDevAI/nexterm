// features/connection/StartupCommandsDialog.tsx — Startup commands preview dialog
//
// Renders before running any startup commands so the user can review and confirm.
// Posture: preview+confirm on every connect — never silent auto-run.

import { Dialog } from "../../components/ui/Dialog";
import { useI18n } from "../../lib/i18n";

interface StartupCommandsDialogProps {
  open: boolean;
  commands: string[];
  profileName?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function StartupCommandsDialog({
  open,
  commands,
  profileName,
  onConfirm,
  onCancel,
}: StartupCommandsDialogProps) {
  const { t } = useI18n();

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title=""
      width="480px"
      aria-labelledby="startup-cmd-title"
    >
      <div className="cd-header">
        <div className="cd-header-text">
          <h3 id="startup-cmd-title" className="cd-title">
            {t("startup.title")}
          </h3>
          {profileName && (
            <span className="cd-header-subtitle">{profileName}</span>
          )}
        </div>
      </div>

      <div className="cd-section">
        <p className="startup-subtitle">{t("startup.subtitle")}</p>
        <ol className="startup-command-list">
          {commands.map((cmd, i) => (
            <li key={i} className="startup-command-item">
              <code>{cmd}</code>
            </li>
          ))}
        </ol>
      </div>

      <div className="cd-actions">
        <button type="button" className="btn-ghost" onClick={onCancel}>
          {t("startup.cancel")}
        </button>
        <div className="cd-actions-right">
          <button type="button" className="btn-primary" onClick={onConfirm}>
            {t("startup.run")}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
