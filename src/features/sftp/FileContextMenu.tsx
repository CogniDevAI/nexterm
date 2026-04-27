// features/sftp/FileContextMenu.tsx — Right-click context menu for files/folders
//
// Shows contextual actions based on entry type and pane source.

import { useEffect, useRef } from "react";
import { useI18n } from "../../lib/i18n";
import type { FileEntry } from "../../lib/types";
import type { PaneSource, FileAction } from "./sftp.types";

interface FileContextMenuProps {
  x: number;
  y: number;
  entry: FileEntry | null;
  source: PaneSource;
  onAction: (action: FileAction) => void;
  onClose: () => void;
}

interface MenuItem {
  label: string;
  action: FileAction;
  danger?: boolean;
}

export function FileContextMenu({
  x,
  y,
  entry,
  source,
  onAction,
  onClose,
}: FileContextMenuProps) {
  const { t } = useI18n();
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handleClick);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [onClose]);

  // Adjust position so menu doesn't go off screen
  useEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const viewW = window.innerWidth;
    const viewH = window.innerHeight;

    if (rect.right > viewW) {
      menuRef.current.style.left = `${x - rect.width}px`;
    }
    if (rect.bottom > viewH) {
      menuRef.current.style.top = `${y - rect.height}px`;
    }
  }, [x, y]);

  // Build menu items based on context
  const items: MenuItem[] = [];

  // A symlink to a file behaves like a file for open/transfer actions
  const isFilelike = (e: FileEntry) =>
    e.fileType === "file" || (e.fileType === "symlink" && e.linkTarget === "file");

  if (entry) {
    // Open action — for regular files and symlinks to files
    if (isFilelike(entry)) {
      items.push({ label: t("ctx.open"), action: { type: "open", entry } });
      items.push({ label: t("ctx.openWith"), action: { type: "openWith", entry } });
    }

    // Save As & Open — remote files only (lets user choose where to save)
    if (source === "remote" && isFilelike(entry)) {
      items.push({
        label: t("ctx.saveAsAndOpen"),
        action: { type: "saveAsAndOpen", entry },
      });
    }

    // Transfer action
    if (source === "local" && isFilelike(entry)) {
      items.push({ label: t("ctx.upload"), action: { type: "upload", entry } });
    }
    if (source === "remote" && isFilelike(entry)) {
      items.push({ label: t("ctx.download"), action: { type: "download", entry } });
    }

    // Edit actions (only on remote for MVP — local fs ops not wired)
    if (source === "remote") {
      items.push({ label: t("ctx.rename"), action: { type: "rename", entry } });
      items.push({
        label: t("ctx.delete"),
        action: { type: "delete", entry },
        danger: true,
      });
    }

    items.push({ label: t("ctx.copyPath"), action: { type: "copyPath", entry } });
  }

  // General actions available regardless of entry selection
  if (source === "remote") {
    items.push({ label: t("ctx.newFolder"), action: { type: "newFolder" } });
  }

  items.push({ label: t("ctx.refresh"), action: { type: "refresh" } });

  // Group items: entry-specific actions, then general actions, separated by a divider
  const entryItems = entry ? items.filter((_, i) => i < items.length - (source === "remote" ? 2 : 1)) : [];
  const generalItems = entry ? items.slice(items.length - (source === "remote" ? 2 : 1)) : items;

  return (
    <div
      ref={menuRef}
      className="sftp-context-menu"
      style={{ left: x, top: y }}
    >
      {entryItems.map((item) => (
        <button
          key={item.label}
          className={`sftp-context-item ${item.danger ? "sftp-context-danger" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            onAction(item.action);
          }}
        >
          {item.label}
        </button>
      ))}
      {entryItems.length > 0 && generalItems.length > 0 && (
        <div className="sftp-context-separator" />
      )}
      {generalItems.map((item) => (
        <button
          key={item.label}
          className={`sftp-context-item ${item.danger ? "sftp-context-danger" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            onAction(item.action);
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
