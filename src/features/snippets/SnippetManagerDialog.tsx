// features/snippets/SnippetManagerDialog.tsx — CRUD manager for the snippet library
//
// Pattern: Dialog (title="") + custom header, mirrors StartupCommandsDialog.
// Allows creating, editing (future), and deleting snippets.

import { useState, useCallback } from "react";
import { Dialog } from "../../components/ui/Dialog";
import { useI18n } from "../../lib/i18n";
import { useSnippetStore } from "../../stores/snippetStore";
import type { Snippet } from "../../stores/snippetStore";

interface SnippetManagerDialogProps {
  open: boolean;
  snippets: Snippet[];
  onClose: () => void;
}

interface FormState {
  name: string;
  template: string;
  folder: string;
}

const EMPTY_FORM: FormState = { name: "", template: "", folder: "" };

export function SnippetManagerDialog({
  open,
  snippets,
  onClose,
}: SnippetManagerDialogProps) {
  const { t } = useI18n();
  const addSnippet = useSnippetStore((s) => s.addSnippet);
  const deleteSnippet = useSnippetStore((s) => s.deleteSnippet);

  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  const handleSave = useCallback(() => {
    if (!form.name.trim() || !form.template.trim()) return;
    addSnippet({
      name: form.name.trim(),
      template: form.template.trim(),
      folder: form.folder.trim() || undefined,
      favorite: false,
    });
    setForm(EMPTY_FORM);
  }, [form, addSnippet]);

  const handleDelete = useCallback(
    (id: string) => {
      deleteSnippet(id);
    },
    [deleteSnippet],
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title=""
      width="540px"
      aria-labelledby="snippet-manager-title"
    >
      <div className="cd-header">
        <div className="cd-header-text">
          <h3 id="snippet-manager-title" className="cd-title">
            {t("snippets.managerTitle")}
          </h3>
        </div>
      </div>

      {/* Add snippet form */}
      <div className="cd-section">
        <div className="snippet-form-row">
          <input
            type="text"
            className="snippet-form-input"
            placeholder={t("snippets.namePlaceholder")}
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
        </div>
        <div className="snippet-form-row">
          <textarea
            className="snippet-form-textarea"
            placeholder={t("snippets.templatePlaceholder")}
            value={form.template}
            onChange={(e) => setForm((f) => ({ ...f, template: e.target.value }))}
            rows={3}
          />
        </div>
        <div className="snippet-form-row">
          <input
            type="text"
            className="snippet-form-input"
            placeholder={t("snippets.folder")}
            value={form.folder}
            onChange={(e) => setForm((f) => ({ ...f, folder: e.target.value }))}
          />
        </div>
        <button
          type="button"
          className="btn-primary"
          onClick={handleSave}
          disabled={!form.name.trim() || !form.template.trim()}
        >
          {t("snippets.save")}
        </button>
      </div>

      {/* Snippet list */}
      <div className="cd-section snippet-manager-list">
        {snippets.length === 0 ? (
          <div className="snippet-empty">{t("snippets.noSnippets")}</div>
        ) : (
          <ul className="snippet-manager-items" role="list">
            {snippets.map((s) => (
              <li key={s.id} className="snippet-manager-item">
                <div className="snippet-manager-item-info">
                  <span className="snippet-manager-item-name">{s.name}</span>
                  <code className="snippet-manager-item-template">{s.template}</code>
                </div>
                <div className="snippet-manager-item-actions">
                  <button
                    type="button"
                    className="btn-ghost snippet-delete-btn"
                    onClick={() => handleDelete(s.id)}
                    title={t("snippets.delete")}
                  >
                    {t("snippets.delete")}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="cd-actions">
        <button type="button" className="btn-ghost" onClick={onClose}>
          {t("general.close")}
        </button>
      </div>
    </Dialog>
  );
}
