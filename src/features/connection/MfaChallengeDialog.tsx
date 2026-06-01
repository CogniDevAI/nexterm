// features/connection/MfaChallengeDialog.tsx — Keyboard-interactive MFA prompt
//
// Mirrors HostKeyDialog overlay/modal structure.
// Renders one input per prompt; echo=false → password, echo=true → text.

import { useState, useEffect } from "react";
import { useI18n } from "../../lib/i18n";
import type { KeyboardInteractiveChallengeRequest } from "../../lib/types";

interface MfaChallengeDialogProps {
  open: boolean;
  challenge: KeyboardInteractiveChallengeRequest | null;
  onSubmit: (answers: string[]) => void;
  onCancel: () => void;
}

export function MfaChallengeDialog({
  open,
  challenge,
  onSubmit,
  onCancel,
}: MfaChallengeDialogProps) {
  const { t } = useI18n();
  const [answers, setAnswers] = useState<string[]>([]);

  // Reset answers whenever the challenge changes (new round or new challenge)
  useEffect(() => {
    if (challenge) {
      setAnswers(challenge.prompts.map(() => ""));
    }
  }, [challenge]);

  if (!challenge || !open) return null;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSubmit(answers);
  }

  function setAnswer(index: number, value: string) {
    setAnswers((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  }

  const titleId = "mfa-dialog-title";

  return (
    <div className="hk-overlay" onClick={onCancel}>
      <div
        className="hk-modal"
        role="dialog"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="hk-header">
          <div className="hk-header-text">
            <h3 id={titleId} className="hk-title">
              {t("mfa.title")}
            </h3>
            {challenge.name && (
              <p className="hk-subtitle">{challenge.name}</p>
            )}
          </div>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="hk-body">
            {challenge.instruction && (
              <p className="hk-mfa-instruction">{challenge.instruction}</p>
            )}

            {challenge.prompts.map((prompt, i) => (
              <div key={i} className="hk-mfa-prompt-row">
                <label
                  htmlFor={`mfa-input-${i}`}
                  className="hk-mfa-prompt-label"
                >
                  {prompt.text}
                </label>
                <input
                  id={`mfa-input-${i}`}
                  className="hk-mfa-input"
                  type={prompt.echo ? "text" : "password"}
                  value={answers[i] ?? ""}
                  onChange={(e) => setAnswer(i, e.target.value)}
                  autoFocus={i === 0}
                  autoComplete="off"
                />
              </div>
            ))}
          </div>

          <div className="hk-actions">
            <button
              type="button"
              className="hk-btn hk-btn-ghost"
              onClick={onCancel}
            >
              {t("mfa.cancel")}
            </button>
            <div className="hk-actions-right">
              <button type="submit" className="hk-btn hk-btn-primary">
                {t("mfa.submit")}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
