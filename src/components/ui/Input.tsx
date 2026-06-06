// components/ui/Input.tsx — Shared input component

import { useState, type InputHTMLAttributes } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  /**
   * Enables an inline show/hide toggle for password fields. Only takes effect
   * when `type === "password"`. Requires `revealLabel` and `hideLabel` for an
   * accessible name on each toggle state.
   */
  reveal?: boolean;
  /** aria-label shown while the password is masked (action: reveal it). */
  revealLabel?: string;
  /** aria-label shown while the password is visible (action: hide it). */
  hideLabel?: string;
}

export function Input({
  label,
  error,
  id,
  className = "",
  reveal = false,
  revealLabel,
  hideLabel,
  type,
  ...props
}: InputProps) {
  const [visible, setVisible] = useState(false);

  const isPassword = type === "password";
  const showReveal = reveal && isPassword;
  const effectiveType = showReveal && visible ? "text" : type;

  return (
    <div className={`input-group ${className}`}>
      {label && (
        <label htmlFor={id} className="input-label">
          {label}
        </label>
      )}
      <div className={`input-field ${showReveal ? "input-field--reveal" : ""}`}>
        <input
          id={id}
          type={effectiveType}
          className={`input ${error ? "input-error" : ""}`}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-form-type="other"
          data-lpignore="true"
          {...props}
        />
        {showReveal && (
          <button
            type="button"
            className="input-reveal-btn"
            tabIndex={-1}
            aria-pressed={visible}
            aria-label={visible ? hideLabel : revealLabel}
            onClick={() => setVisible((v) => !v)}
          >
            {visible ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                <line x1="1" y1="1" x2="23" y2="23" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            )}
          </button>
        )}
      </div>
      {error && <span className="input-error-text">{error}</span>}
    </div>
  );
}
