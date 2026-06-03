// features/history/HistoryPanel.tsx — Command history side panel
//
// Displays per-session typed command history with filter, copy, insert,
// execute (via injectSnippet), per-entry delete, and clear-all actions.
//
// SECURITY:
//   - captureEnabled defaults to FALSE (opt-in). This panel displays an
//     explicit toggle and a first-use privacy notice explaining the risk.
//   - When capture is OFF, an explanatory empty state is shown.
//   - The one-time notice is shown until noticeAcknowledged=true in the store.

import { useState } from "react";
import { useI18n } from "../../lib/i18n";
import { useCommandHistoryStore } from "../../stores/commandHistoryStore";
import { injectSnippet } from "../snippets/useSnippetInject";

// ── Props ─────────────────────────────────────────────────────────────────────

interface HistoryPanelProps {
  sessionId: string;
  terminalId: string | null | undefined;
  host: string;
}

// ── HistoryPanel ──────────────────────────────────────────────────────────────

export function HistoryPanel({ sessionId, terminalId, host }: HistoryPanelProps) {
  const { t } = useI18n();

  const entries = useCommandHistoryStore((s) => s.entries);
  const captureEnabled = useCommandHistoryStore((s) => s.captureEnabled);
  const noticeAcknowledged = useCommandHistoryStore((s) => s.noticeAcknowledged);
  const toggleCapture = useCommandHistoryStore((s) => s.toggleCapture);
  const deleteCommand = useCommandHistoryStore((s) => s.deleteCommand);
  const clearAll = useCommandHistoryStore((s) => s.clearAll);
  const dismissNotice = useCommandHistoryStore((s) => s.dismissNotice);

  const [filterText, setFilterText] = useState("");
  const [filterByHost, setFilterByHost] = useState(false);

  // ── Filtering ───────────────────────────────────────────────────────────────
  const visible = entries.filter((e) => {
    if (filterByHost && e.host !== host) return false;
    if (filterText && !e.command.toLowerCase().includes(filterText.toLowerCase()))
      return false;
    return true;
  });

  // ── Handlers ────────────────────────────────────────────────────────────────
  function handleCopy(command: string) {
    void navigator.clipboard.writeText(command);
  }

  function handleInsert(command: string) {
    void injectSnippet(sessionId, terminalId, command, "insert");
  }

  function handleExecute(command: string) {
    void injectSnippet(sessionId, terminalId, command, "execute");
  }

  function handleDelete(id: string) {
    deleteCommand(id);
  }

  function handleClearAll() {
    if (window.confirm(t("history.clearAll") + "?")) {
      clearAll();
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="history-panel">
      {/* Privacy notice — shown until acknowledged */}
      {!noticeAcknowledged && (
        <div className="history-notice" role="alert">
          <strong>{t("history.noticeTitle")}</strong>
          <p>{t("history.noticeMessage")}</p>
          <button type="button" onClick={() => dismissNotice()}>
            {t("history.noticeDismiss")}
          </button>
        </div>
      )}

      {/* Header toolbar — capture toggle + clear-all */}
      <div className="history-toolbar">
        <label className="history-capture-toggle">
          <input
            type="checkbox"
            aria-label={t("history.captureToggleLabel")}
            checked={captureEnabled}
            onChange={() => toggleCapture()}
          />
          <span>{t("history.captureToggleLabel")}</span>
        </label>

        <button
          type="button"
          className="history-clear-btn"
          onClick={handleClearAll}
          aria-label={t("history.clearAll")}
        >
          {t("history.clearAll")}
        </button>
      </div>

      {/* Filter row */}
      {captureEnabled && (
        <div className="history-filters">
          <input
            type="text"
            className="history-filter-input"
            placeholder={t("history.filter")}
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
          />
          <label className="history-host-filter">
            <input
              type="checkbox"
              aria-label={t("history.filterByHost")}
              checked={filterByHost}
              onChange={(e) => setFilterByHost(e.target.checked)}
            />
            <span>{t("history.filterByHost")}</span>
          </label>
        </div>
      )}

      {/* Entry list or empty state */}
      {!captureEnabled ? (
        <div className="history-empty">
          <p>{t("history.captureOff")}</p>
          <p className="history-empty-hint">{t("history.enableCapture")}</p>
        </div>
      ) : visible.length === 0 ? (
        <div className="history-empty">
          <p>{t("history.empty")}</p>
        </div>
      ) : (
        <ul className="history-list" aria-label="command history">
          {visible.map((entry) => (
            <li key={entry.id} className="history-entry">
              <span className="history-entry-command">{entry.command}</span>
              <div className="history-entry-actions">
                <button
                  type="button"
                  aria-label={t("history.copy")}
                  onClick={() => handleCopy(entry.command)}
                >
                  {t("history.copy")}
                </button>
                <button
                  type="button"
                  aria-label={t("history.insert")}
                  onClick={() => handleInsert(entry.command)}
                >
                  {t("history.insert")}
                </button>
                <button
                  type="button"
                  aria-label={t("history.execute")}
                  onClick={() => handleExecute(entry.command)}
                >
                  {t("history.execute")}
                </button>
                <button
                  type="button"
                  aria-label={t("history.delete")}
                  onClick={() => handleDelete(entry.id)}
                >
                  {t("history.delete")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
