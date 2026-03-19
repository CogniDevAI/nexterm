// features/tunnel/TunnelForm.tsx — Create/edit tunnel configuration dialog
//
// Premium redesign: cd-* design system, segmented type selector,
// grouped sections, SSH preview, consistent button hierarchy.

import { useState, useCallback } from "react";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { Dialog } from "../../components/ui/Dialog";
import { useI18n } from "../../lib/i18n";
import type { TunnelType } from "../../lib/types";
import {
  type TunnelFormData,
  type TunnelFormErrors,
  validateTunnelForm,
} from "./tunnel.types";

interface TunnelFormProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: TunnelFormData) => void;
}

/* ─── Icons ───────────────────────────────────────── */

function TunnelIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />
    </svg>
  );
}

function ArrowIcon({ direction }: { direction: "right" | "left" }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {direction === "right" ? (
        <>
          <line x1="5" y1="12" x2="19" y2="12" />
          <polyline points="12 5 19 12 12 19" />
        </>
      ) : (
        <>
          <line x1="19" y1="12" x2="5" y2="12" />
          <polyline points="12 19 5 12 12 5" />
        </>
      )}
    </svg>
  );
}

const INITIAL_FORM: TunnelFormData = {
  tunnelType: "local",
  bindHost: "127.0.0.1",
  bindPort: "",
  targetHost: "",
  targetPort: "",
  label: "",
};

export function TunnelForm({ open, onClose, onSubmit }: TunnelFormProps) {
  const { t } = useI18n();
  const [form, setForm] = useState<TunnelFormData>({ ...INITIAL_FORM });
  const [errors, setErrors] = useState<TunnelFormErrors>({});

  const updateField = useCallback(
    <K extends keyof TunnelFormData>(key: K, value: TunnelFormData[K]) => {
      setForm((prev) => ({ ...prev, [key]: value }));
      setErrors((prev) => ({ ...prev, [key]: undefined }));
    },
    [],
  );

  const handleSubmit = useCallback(() => {
    const validationErrors = validateTunnelForm(form);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }
    onSubmit(form);
    setForm({ ...INITIAL_FORM });
    setErrors({});
    onClose();
  }, [form, onSubmit, onClose]);

  const handleClose = useCallback(() => {
    setForm({ ...INITIAL_FORM });
    setErrors({});
    onClose();
  }, [onClose]);

  const handleTypeChange = useCallback(
    (type: TunnelType) => {
      updateField("tunnelType", type);
      if (type === "local") {
        updateField("bindHost", "127.0.0.1");
      } else {
        updateField("bindHost", "0.0.0.0");
      }
    },
    [updateField],
  );

  const isLocal = form.tunnelType === "local";
  const bindLabel = isLocal ? t("tunnelForm.listenLocal") : t("tunnelForm.listenRemote");
  const targetLabel = isLocal ? t("tunnelForm.destRemote") : t("tunnelForm.destLocal");
  const description = isLocal ? t("tunnelForm.descLocal") : t("tunnelForm.descRemote");

  return (
    <Dialog open={open} onClose={handleClose} title="" width="460px">
      {/* ─── Custom Header with Icon ─── */}
      <div className="cd-header">
        <div className="cd-header-icon">
          <TunnelIcon />
        </div>
        <div className="cd-header-text">
          <h3 className="cd-title">{t("tunnelForm.title")}</h3>
          <p className="cd-subtitle">{description}</p>
        </div>
      </div>

      {/* ─── Section: Tunnel Type ─── */}
      <div className="cd-section">
        <div className="cd-section-label">{t("tunnelForm.typeLabel") || "Type"}</div>
        <div className="cd-section-content">
          {/* Segmented control for tunnel type */}
          <div className="cd-segmented">
            <button
              type="button"
              className={`cd-segmented-btn ${form.tunnelType === "local" ? "cd-segmented-btn-active" : ""}`}
              onClick={() => handleTypeChange("local")}
            >
              <span className="tunnel-type-icon">-L</span>
              <span>{t("tunnel.localShort")}</span>
            </button>
            <button
              type="button"
              className={`cd-segmented-btn ${form.tunnelType === "remote" ? "cd-segmented-btn-active" : ""}`}
              onClick={() => handleTypeChange("remote")}
            >
              <span className="tunnel-type-icon">-R</span>
              <span>{t("tunnel.remoteShort")}</span>
            </button>
          </div>

          <Input
            id="tunnel-label"
            label={t("tunnelForm.labelField")}
            value={form.label}
            onChange={(e) => updateField("label", e.target.value)}
            placeholder={t("tunnelForm.labelPlaceholder")}
          />
        </div>
      </div>

      {/* ─── Section: Bind (listen) ─── */}
      <div className="cd-section">
        <div className="cd-section-label">{bindLabel}</div>
        <div className="cd-section-content">
          <div className="cd-row">
            <Input
              id="tunnel-bind-host"
              label={t("tunnelForm.host")}
              value={form.bindHost}
              error={errors.bindHost}
              onChange={(e) => updateField("bindHost", e.target.value)}
              placeholder={isLocal ? "127.0.0.1" : "0.0.0.0"}
              className="cd-row-flex"
            />
            <Input
              id="tunnel-bind-port"
              label={t("tunnelForm.port")}
              type="number"
              value={form.bindPort}
              error={errors.bindPort}
              onChange={(e) => updateField("bindPort", e.target.value)}
              placeholder="8080"
              className="cd-row-port"
            />
          </div>
        </div>
      </div>

      {/* ─── Arrow ─── */}
      <div className="tunnel-form-arrow">
        <ArrowIcon direction={isLocal ? "right" : "left"} />
      </div>

      {/* ─── Section: Target (destination) ─── */}
      <div className="cd-section">
        <div className="cd-section-label">{targetLabel}</div>
        <div className="cd-section-content">
          <div className="cd-row">
            <Input
              id="tunnel-target-host"
              label={t("tunnelForm.host")}
              value={form.targetHost}
              error={errors.targetHost}
              onChange={(e) => updateField("targetHost", e.target.value)}
              placeholder={isLocal ? "db.internal" : "localhost"}
              className="cd-row-flex"
            />
            <Input
              id="tunnel-target-port"
              label={t("tunnelForm.port")}
              type="number"
              value={form.targetPort}
              error={errors.targetPort}
              onChange={(e) => updateField("targetPort", e.target.value)}
              placeholder="5432"
              className="cd-row-port"
            />
          </div>
        </div>
      </div>

      {/* ─── SSH equivalent preview ─── */}
      <div className="tunnel-form-preview">
        <span className="tunnel-form-preview-label">{t("tunnelForm.sshEquiv")}</span>
        <code className="tunnel-form-preview-cmd">
          ssh {isLocal ? "-L" : "-R"} {form.bindHost || "*"}:
          {form.bindPort || "?"}:{form.targetHost || "?"}:
          {form.targetPort || "?"} ...
        </code>
      </div>

      {/* ─── Footer Actions ─── */}
      <div className="cd-actions">
        <Button variant="ghost" onClick={handleClose}>
          {t("tunnelForm.cancel")}
        </Button>
        <Button onClick={handleSubmit}>
          {t("tunnelForm.submit")}
        </Button>
      </div>
    </Dialog>
  );
}
