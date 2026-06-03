// features/snippets/SnippetPickerModal.tsx — Snippet picker with search
//
// Renders a searchable list of snippets. When the user clicks a snippet:
//   - No user-defined vars → onPick(snippet, []) immediately (skip variable modal)
//   - Has user-defined vars → onPick(snippet, variableTokens) to open SnippetVariableModal
//
// Dynamic built-in vars (HOST/USERNAME/PORT/SESSION_ID) are NOT counted as
// user-defined vars — they are resolved silently by the parent and pre-filled.

import { useState, useMemo, useCallback } from "react";
import { Dialog } from "../../components/ui/Dialog";
import { useI18n } from "../../lib/i18n";
import { tokenize } from "./snippetParser";
import type { Token } from "./snippetParser";
import { DYNAMIC_VAR_NAMES } from "./resolveSessionVars";
import type { Snippet } from "../../stores/snippetStore";

interface SnippetPickerModalProps {
  open: boolean;
  snippets: Snippet[];
  /** Called with the chosen snippet and its user-variable tokens (empty if none). */
  onPick: (snippet: Snippet, variables: Token[]) => void;
  /** Open the snippet manager dialog */
  onManage: () => void;
  onClose: () => void;
}

const DYNAMIC_SET = new Set<string>(DYNAMIC_VAR_NAMES);

/** Extract user-defined variable tokens (excludes built-in dynamic vars). */
function getUserVariables(template: string): Token[] {
  return tokenize(template).filter(
    (tok): tok is Extract<Token, { kind: "variable" }> =>
      tok.kind === "variable" && !DYNAMIC_SET.has(tok.name),
  );
}

export function SnippetPickerModal({
  open,
  snippets,
  onPick,
  onManage,
  onClose,
}: SnippetPickerModalProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    if (!query.trim()) return snippets;
    const q = query.toLowerCase();
    return snippets.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.template.toLowerCase().includes(q),
    );
  }, [snippets, query]);

  const handlePick = useCallback(
    (snippet: Snippet) => {
      const vars = getUserVariables(snippet.template);
      onPick(snippet, vars);
    },
    [onPick],
  );

  // Reset query when modal closes
  const handleClose = useCallback(() => {
    setQuery("");
    onClose();
  }, [onClose]);

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title=""
      width="480px"
      aria-labelledby="snippet-picker-title"
    >
      <div className="cd-header">
        <div className="cd-header-text">
          <h3 id="snippet-picker-title" className="cd-title">
            {t("snippets.pickerTitle")}
          </h3>
        </div>
        <button
          type="button"
          className="btn-ghost snippet-manage-btn"
          onClick={onManage}
          title={t("snippets.manage")}
        >
          {t("snippets.manage")}
        </button>
      </div>

      <div className="cd-section">
        <input
          role="searchbox"
          type="search"
          className="snippet-search"
          placeholder={t("snippets.searchPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />

        {filtered.length === 0 ? (
          <div className="snippet-empty">{t("snippets.empty")}</div>
        ) : (
          <ul className="snippet-list" role="list">
            {filtered.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className={`snippet-item ${s.favorite ? "snippet-item-favorite" : ""}`}
                  onClick={() => handlePick(s)}
                >
                  <span className="snippet-item-name">{s.name}</span>
                  {s.folder && (
                    <span className="snippet-item-folder">{s.folder}</span>
                  )}
                  <code className="snippet-item-template">{s.template}</code>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="cd-actions">
        <button type="button" className="btn-ghost" onClick={handleClose}>
          {t("general.cancel")}
        </button>
      </div>
    </Dialog>
  );
}
