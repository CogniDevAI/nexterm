// features/connection/AuthPrompt.tsx — Password/passphrase input modal
//
// Premium redesign: icon header, toggle switch, consistent layout

import { useState } from "react";
import { Dialog } from "../../components/ui/Dialog";
import { Input } from "../../components/ui/Input";
import { Button } from "../../components/ui/Button";
import { useI18n } from "../../lib/i18n";

interface AuthPromptProps {
  open: boolean;
  host: string;
  username: string;
  profileId: string | null;
  onSubmit: (password: string, remember: boolean) => void;
  onCancel: () => void;
}

function LockIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

export function AuthPrompt({
  open,
  host,
  username,
  profileId,
  onSubmit,
  onCancel,
}: AuthPromptProps) {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [rememberPassword, setRememberPassword] = useState(false);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password.trim()) {
      onSubmit(password, rememberPassword);
      setPassword("");
      setRememberPassword(false);
    }
  }

  return (
    <Dialog open={open} onClose={onCancel} title="" width="420px">
      <form onSubmit={handleSubmit} autoComplete="off">
        {/* ─── Header with icon ─── */}
        <div className="cd-header">
          <div className="cd-header-icon cd-header-icon-warning">
            <LockIcon />
          </div>
          <div className="cd-header-text">
            <h3 className="cd-title">{t("auth.title")}</h3>
            <p className="cd-subtitle">
              {t("auth.enterPassword", { user: `${username}@${host}` })}
            </p>
          </div>
        </div>

        {/* ─── Password field ─── */}
        <div className="cd-section-content" style={{ marginTop: 4 }}>
          <Input
            id="auth-password"
            type="password"
            label={t("auth.password")}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t("auth.password")}
            autoFocus
          />
          {profileId && (
            <div className="cd-toggle-row">
              <button
                type="button"
                className={`cd-toggle ${rememberPassword ? "cd-toggle-on" : ""}`}
                onClick={() => setRememberPassword(!rememberPassword)}
                role="switch"
                aria-checked={rememberPassword}
              >
                <span className="cd-toggle-thumb" />
              </button>
              <span className="cd-toggle-label">
                {t("auth.rememberKeychain")}
              </span>
            </div>
          )}
        </div>

        {/* ─── Actions ─── */}
        <div className="cd-actions">
          <Button variant="ghost" type="button" onClick={onCancel}>
            {t("auth.cancel")}
          </Button>
          <Button type="submit" disabled={!password.trim()}>
            {t("auth.connect")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
