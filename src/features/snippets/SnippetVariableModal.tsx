// features/snippets/SnippetVariableModal.tsx — Variable-fill modal with live preview
//
// Pattern: Dialog (title="") + custom header, mirrors StartupCommandsDialog.
// Security invariants:
//   - Password-type VALUES are held only in local React state (never in Zustand).
//   - Live preview replaces password values with "***".
//   - Values are discarded when the modal closes or after onInject returns.

import { useState, useCallback, useEffect } from "react";
import { Dialog } from "../../components/ui/Dialog";
import { useI18n } from "../../lib/i18n";
import { resolveTemplate } from "./snippetParser";
import type { Token } from "./snippetParser";
import type { InjectionMode } from "./useSnippetInject";

export interface InjectPayload {
  resolvedCommand: string;
  mode: InjectionMode;
}

interface SnippetVariableModalProps {
  open: boolean;
  /** Raw template string (used for live preview). */
  template: string;
  /** Variable tokens that require user input (dynamic/built-in vars already pre-filled). */
  variables: Token[];
  onInject: (payload: InjectPayload) => void;
  onClose: () => void;
  /** Optional snippet name for the header subtitle */
  snippetName?: string;
  /**
   * Pre-resolved values for dynamic/built-in vars (HOST, USERNAME, etc.).
   * These are merged into the preview resolution so the preview shows live
   * session values, but they do NOT produce input fields.
   */
  prefilledValues?: Record<string, string>;
}

/** Build initial values map from variable defaults */
function buildInitialValues(variables: Token[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const tok of variables) {
    if (tok.kind === "variable") {
      values[tok.name] = tok.default ?? "";
    }
  }
  return values;
}

/** Resolve template for preview — masks password-type values with *** */
function resolveForPreview(
  template: string,
  values: Record<string, string>,
  variables: Token[],
  prefilledValues?: Record<string, string>,
): string {
  // Merge: prefilled (dynamic) vars first, then user-typed values on top
  const previewValues: Record<string, string> = { ...prefilledValues, ...values };
  for (const tok of variables) {
    if (tok.kind === "variable" && tok.type === "password" && values[tok.name]) {
      previewValues[tok.name] = "***";
    }
  }
  try {
    return resolveTemplate(template, previewValues);
  } catch {
    return template;
  }
}

const userVarTokens = (variables: Token[]) =>
  variables.filter((t): t is Extract<Token, { kind: "variable" }> => t.kind === "variable");

export function SnippetVariableModal({
  open,
  template,
  variables,
  onInject,
  onClose,
  snippetName,
  prefilledValues,
}: SnippetVariableModalProps) {
  const { t } = useI18n();
  const vars = userVarTokens(variables);

  const [values, setValues] = useState<Record<string, string>>(() =>
    buildInitialValues(variables),
  );

  // Reset values when the modal opens with new variables.
  // Also clear password-type values when the modal closes (memory hygiene —
  // prevents typed secrets from lingering in React state while the dialog is
  // hidden; they never reach localStorage but clearing on close is defensive).
  useEffect(() => {
    if (open) {
      setValues(buildInitialValues(variables));
    } else {
      // Clear any password values on close transition
      setValues((prev) => {
        const cleared = { ...prev };
        for (const tok of variables) {
          if (tok.kind === "variable" && tok.type === "password") {
            cleared[tok.name] = "";
          }
        }
        return cleared;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, template]);

  const preview = resolveForPreview(template, values, variables, prefilledValues);

  const handleChange = useCallback((name: string, value: string) => {
    setValues((prev) => ({ ...prev, [name]: value }));
  }, []);

  const handleInject = useCallback(
    (mode: InjectionMode) => {
      try {
        // Merge prefilled (dynamic) vars with user-typed values; user values take precedence
        const allValues = { ...prefilledValues, ...values };
        const resolvedCommand = resolveTemplate(template, allValues);
        onInject({ resolvedCommand, mode });
        // SECURITY: Clear password values immediately after injection
        const cleared = { ...values };
        for (const tok of vars) {
          if (tok.type === "password") {
            cleared[tok.name] = "";
          }
        }
        setValues(cleared);
      } catch {
        // Missing variable — do not inject, let user fill in the field
      }
    },
    [template, values, vars, onInject, prefilledValues],
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title=""
      width="480px"
      aria-labelledby="snippet-var-title"
    >
      <div className="cd-header">
        <div className="cd-header-text">
          <h3 id="snippet-var-title" className="cd-title">
            {t("snippets.fillVariables")}
          </h3>
          {snippetName && (
            <span className="cd-header-subtitle">{snippetName}</span>
          )}
        </div>
      </div>

      <div className="cd-section">
        {vars.map((tok) => {
          const inputId = `snippet-var-${tok.name}`;
          return (
            <div key={tok.name} className="snippet-var-row">
              <label htmlFor={inputId} className="snippet-var-label">
                {tok.name}
              </label>
              {tok.type === "choice" && tok.choices ? (
                <select
                  id={inputId}
                  className="snippet-var-select"
                  value={values[tok.name] ?? tok.default ?? ""}
                  onChange={(e) => handleChange(tok.name, e.target.value)}
                >
                  {tok.choices.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={inputId}
                  className="snippet-var-input"
                  type={tok.type === "password" ? "password" : tok.type === "number" ? "number" : "text"}
                  value={values[tok.name] ?? ""}
                  onChange={(e) => handleChange(tok.name, e.target.value)}
                  placeholder={tok.default}
                  autoComplete="off"
                />
              )}
            </div>
          );
        })}

        {/* Live preview */}
        <div className="snippet-preview-label">{t("snippets.preview")}</div>
        <code
          data-testid="snippet-preview"
          className="snippet-preview"
        >
          {preview}
        </code>
      </div>

      <div className="cd-actions">
        <button type="button" className="btn-ghost" onClick={onClose}>
          {t("general.cancel")}
        </button>
        <div className="cd-actions-right">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => handleInject("insert")}
          >
            {t("snippets.insert")}
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => handleInject("execute")}
          >
            {t("snippets.execute")}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
