// components/ui/Dialog.tsx — Modal dialog component
//
// Premium pattern: backdrop blur, slide-up animation, optional title.
// When title is empty string, header is hidden (for custom headers).
// `className` prop merges onto `.dialog-content` for per-dialog tweaks.

import { useEffect, useRef, type ReactNode } from "react";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  width?: string;
  /** Extra class on the inner content wrapper */
  className?: string;
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  width = "480px",
  className = "",
}: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  // Sync the `open` prop with the native <dialog> modal state.
  // The dialog stays mounted so useEffect always has a valid ref.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className="dialog"
      style={{ width }}
      onClose={(e) => {
        // Native close event (Escape key, .close() call) — sync back to React state
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        // Close on backdrop click
        if (e.target === dialogRef.current) {
          onClose();
        }
      }}
    >
      {open && (
        <div className={`dialog-content ${className}`.trim()}>
          {title && (
            <div className="dialog-header">
              <h3 className="dialog-title">{title}</h3>
              <button className="dialog-close" onClick={onClose}>
                &times;
              </button>
            </div>
          )}
          <div className={title ? "dialog-body" : "dialog-body-custom"}>
            {children}
          </div>
        </div>
      )}
    </dialog>
  );
}
