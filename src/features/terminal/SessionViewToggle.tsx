// features/terminal/SessionViewToggle.tsx — Persistent Terminal | Files view switch
//
// Lives in a slim bar at the top of the session main column, OUTSIDE the
// terminal area that gets display:none'd in files view. This guarantees the
// toggle is ALWAYS visible so the user can switch back from Files to Terminal.

import { useWorkspaceStore, type MainView } from "../../stores/workspaceStore";
import { useI18n } from "../../lib/i18n";

interface SessionViewToggleProps {
  workspaceKey: string;
  mainView: MainView;
}

export function SessionViewToggle({ workspaceKey, mainView }: SessionViewToggleProps) {
  const { t } = useI18n();
  const setMainView = useWorkspaceStore((s) => s.setMainView);

  return (
    <div className="session-view-toggle-bar">
      <div className="session-view-toggle" role="group" aria-label="View">
        <button
          type="button"
          className={`session-view-toggle-btn${mainView === "terminal" ? " session-view-toggle-btn-active" : ""}`}
          aria-pressed={mainView === "terminal"}
          onClick={() => setMainView(workspaceKey, "terminal")}
        >
          {t("view.terminal")}
        </button>
        <button
          type="button"
          className={`session-view-toggle-btn${mainView === "files" ? " session-view-toggle-btn-active" : ""}`}
          aria-pressed={mainView === "files"}
          onClick={() => setMainView(workspaceKey, "files")}
        >
          {t("view.files")}
        </button>
      </div>
    </div>
  );
}
