// features/connection/KeygenDialog.tsx — In-app SSH keypair generation dialog
//
// Lets users generate Ed25519 (default), RSA 2048/4096, or ECDSA P-256/P-384
// keypairs directly inside NexTerm.
//
// v1 scope:
// - Generate keypair + write to ~/.ssh/{filename} / {filename}.pub
// - Show public key in a code block with a Copy button
// - "Use this key" callback sets the generated private key as the connection identity
// - DEFER: authorized_keys push (show pubkey + instruct user to ssh-copy-id)

import { useState } from "react";
import { Dialog } from "../../components/ui/Dialog";
import { useI18n } from "../../lib/i18n";
import { tauriInvoke } from "../../lib/tauri";
import type { GenerateSshKeyResult } from "../../lib/types";

// ─── Algorithm Options ────────────────────────────────────

const ALGORITHM_OPTIONS = [
  { value: "ed25519", label: "Ed25519 (recommended)" },
  { value: "rsa2048", label: "RSA 2048" },
  { value: "rsa4096", label: "RSA 4096" },
  { value: "ecdsaP256", label: "ECDSA P-256" },
  { value: "ecdsaP384", label: "ECDSA P-384" },
] as const;

type AlgorithmValue = (typeof ALGORITHM_OPTIONS)[number]["value"];

// ─── Props ────────────────────────────────────────────────

interface KeygenDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called with the private key path when the user clicks "Use this key" */
  onKeyGenerated: (privateKeyPath: string) => void;
}

// ─── Component ────────────────────────────────────────────

export function KeygenDialog({ open, onClose, onKeyGenerated }: KeygenDialogProps) {
  const { t } = useI18n();

  // Form state
  const [algorithm, setAlgorithm] = useState<AlgorithmValue>("ed25519");
  const [comment, setComment] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [filename, setFilename] = useState("id_ed25519");

  // Generation state
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<GenerateSshKeyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Sync default filename when algorithm changes
  function handleAlgorithmChange(value: AlgorithmValue) {
    setAlgorithm(value);
    // Only auto-update filename if still at a default value
    const defaults: Record<AlgorithmValue, string> = {
      ed25519: "id_ed25519",
      rsa2048: "id_rsa",
      rsa4096: "id_rsa",
      ecdsaP256: "id_ecdsa",
      ecdsaP384: "id_ecdsa",
    };
    const isDefaultFilename = Object.values(defaults).includes(filename);
    if (isDefaultFilename) {
      setFilename(defaults[value]);
    }
  }

  async function handleGenerate() {
    if (!filename.trim()) return;

    setGenerating(true);
    setError(null);
    setResult(null);

    try {
      const res = await tauriInvoke<GenerateSshKeyResult>("generate_ssh_key", {
        algorithm,
        comment: comment.trim() || "",
        passphrase: passphrase.trim() || null,
        filename: filename.trim(),
      });
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  }

  async function handleCopy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.publicKeyOpenssh);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard write failed — ignore silently
    }
  }

  function handleUseKey() {
    if (!result) return;
    onKeyGenerated(result.privateKeyPath);
    handleClose();
  }

  function handleClose() {
    // Reset state on close so re-opening starts fresh
    setAlgorithm("ed25519");
    setComment("");
    setPassphrase("");
    setFilename("id_ed25519");
    setGenerating(false);
    setResult(null);
    setError(null);
    setCopied(false);
    onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title=""
      width="520px"
      aria-labelledby="keygen-dialog-title"
    >
      <div className="cd-header">
        <div className="cd-header-text">
          <h3 id="keygen-dialog-title" className="cd-title">
            {t("keygen.title")}
          </h3>
        </div>
      </div>

      {/* ─── Generation Form (shown before success) ─── */}
      {!result && (
        <div className="cd-section">
          <div className="cd-section-content">
            {/* Algorithm */}
            <div className="cd-field">
              <label htmlFor="keygen-algorithm" className="cd-field-label">
                {t("keygen.algorithm")}
              </label>
              <select
                id="keygen-algorithm"
                className="cd-user-row-input"
                value={algorithm}
                onChange={(e) => handleAlgorithmChange(e.target.value as AlgorithmValue)}
                disabled={generating}
              >
                {ALGORITHM_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Comment */}
            <div className="cd-field">
              <label htmlFor="keygen-comment" className="cd-field-label">
                {t("keygen.comment")}
              </label>
              <input
                id="keygen-comment"
                type="text"
                className="cd-user-row-input"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder={t("keygen.commentPlaceholder")}
                disabled={generating}
                spellCheck={false}
              />
            </div>

            {/* Passphrase */}
            <div className="cd-field">
              <label htmlFor="keygen-passphrase" className="cd-field-label">
                {t("keygen.passphrase")}
              </label>
              <input
                id="keygen-passphrase"
                type="password"
                className="cd-user-row-input"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder={t("keygen.passphrasePlaceholder")}
                disabled={generating}
                autoComplete="new-password"
              />
            </div>

            {/* Filename */}
            <div className="cd-field">
              <label htmlFor="keygen-filename" className="cd-field-label">
                {t("keygen.filename")}
              </label>
              <input
                id="keygen-filename"
                type="text"
                className="cd-user-row-input"
                value={filename}
                onChange={(e) => setFilename(e.target.value)}
                placeholder={t("keygen.filenamePlaceholder")}
                disabled={generating}
                spellCheck={false}
              />
            </div>

            {/* Error */}
            {error && (
              <p className="cd-error-text" role="alert">
                {error}
              </p>
            )}
          </div>
        </div>
      )}

      {/* ─── Public Key Result (shown after success) ─── */}
      {result && (
        <div className="cd-section">
          <div className="cd-section-content">
            <p className="keygen-pubkey-label">{t("keygen.publicKeyLabel")}</p>
            <div className="keygen-pubkey-block">
              <code className="keygen-pubkey-code">{result.publicKeyOpenssh}</code>
            </div>
            <div className="keygen-pubkey-actions">
              <button
                type="button"
                className="btn-ghost keygen-copy-btn"
                onClick={handleCopy}
              >
                {copied ? t("keygen.copied") : t("keygen.copyPublicKey")}
              </button>
            </div>
            <p className="keygen-path-hint">
              {result.privateKeyPath}
            </p>
          </div>
        </div>
      )}

      {/* ─── Footer Actions ─── */}
      <div className="cd-actions">
        <button type="button" className="btn-ghost" onClick={handleClose}>
          {result ? t("keygen.done") : t("keygen.cancel")}
        </button>

        <div className="cd-actions-right">
          {result ? (
            <button type="button" className="btn-primary" onClick={handleUseKey}>
              {t("keygen.useThisKey")}
            </button>
          ) : (
            <button
              type="button"
              className="btn-primary"
              onClick={handleGenerate}
              disabled={generating || !filename.trim()}
            >
              {generating ? t("keygen.generating") : t("keygen.generate")}
            </button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
