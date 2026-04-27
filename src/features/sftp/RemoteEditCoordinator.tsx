// features/sftp/RemoteEditCoordinator.tsx — Coordinates remote temp-file edits

import { useCallback, useEffect, useMemo, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { stat } from "@tauri-apps/plugin-fs";
import { Dialog } from "../../components/ui/Dialog";
import { Button } from "../../components/ui/Button";
import { useI18n } from "../../lib/i18n";
import { tauriInvoke } from "../../lib/tauri";
import type { TransferEvent } from "../../lib/types";
import { useRemoteEditStore } from "../../stores/remoteEditStore";

function normalizeMtime(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  return null;
}

export function RemoteEditCoordinator() {
  const { t } = useI18n();
  const sessions = useRemoteEditStore((state) => state.sessions);
  const promptSessionId = useRemoteEditStore((state) => state.promptSessionId);
  const closingRequested = useRemoteEditStore((state) => state.closingRequested);
  const setPromptSessionId = useRemoteEditStore((state) => state.setPromptSessionId);
  const markDirty = useRemoteEditStore((state) => state.markDirty);
  const markSyncing = useRemoteEditStore((state) => state.markSyncing);
  const markSynced = useRemoteEditStore((state) => state.markSynced);
  const updateMtime = useRemoteEditStore((state) => state.updateMtime);
  const requestCloseProtection = useRemoteEditStore(
    (state) => state.requestCloseProtection,
  );
  const clearCloseProtection = useRemoteEditStore(
    (state) => state.clearCloseProtection,
  );

  const [actionError, setActionError] = useState<string | null>(null);

  const sessionList = useMemo(() => Object.values(sessions), [sessions]);
  const promptSession = promptSessionId ? sessions[promptSessionId] : null;

  useEffect(() => {
    setActionError(null);
  }, [promptSessionId]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      const currentSessions = Object.values(useRemoteEditStore.getState().sessions);
      for (const session of currentSessions) {
        if (session.syncing) continue;
        void stat(session.localPath)
          .then((metadata) => {
            const mtime = normalizeMtime(metadata.mtime);
            const latest = useRemoteEditStore.getState().sessions[session.id];
            if (!latest) return;
            if (latest.lastKnownMtime === null) {
              updateMtime(session.id, mtime);
              return;
            }
            if (
              mtime !== null &&
              latest.lastKnownMtime !== null &&
              mtime > latest.lastKnownMtime &&
              !latest.dirty
            ) {
              markDirty(session.id);
            }
          })
          .catch(() => {
            // Temp file may have been removed by the editor or OS.
          });
      }
    }, 1500);

    return () => window.clearInterval(interval);
  }, [markDirty, updateMtime]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    void getCurrentWindow()
      .onCloseRequested((event) => {
        const hasPending = Object.values(useRemoteEditStore.getState().sessions).some(
          (session) => session.dirty || session.syncing,
        );
        if (!hasPending) return;
        event.preventDefault();
        requestCloseProtection();
        const nextDirty = Object.values(useRemoteEditStore.getState().sessions).find(
          (session) => session.dirty,
        );
        if (nextDirty) {
          useRemoteEditStore.getState().setPromptSessionId(nextDirty.id);
        }
      })
      .then((fn) => {
        unlisten = fn;
      });

    return () => {
      unlisten?.();
    };
  }, [requestCloseProtection]);

  useEffect(() => {
    if (!closingRequested) return;
    const nextDirty = sessionList.find((session) => session.dirty);
    if (nextDirty) {
      if (promptSessionId !== nextDirty.id) {
        setPromptSessionId(nextDirty.id);
      }
      return;
    }

    const hasSyncing = sessionList.some((session) => session.syncing);
    if (hasSyncing) return;

    clearCloseProtection();
    void getCurrentWindow().close();
  }, [
    clearCloseProtection,
    closingRequested,
    promptSessionId,
    sessionList,
    setPromptSessionId,
  ]);

  const handleUpload = useCallback(async () => {
    if (!promptSession) return;
    setActionError(null);
    markSyncing(promptSession.id, true);
    const channel = new Channel<TransferEvent>();

    try {
      await tauriInvoke<void>("sftp_upload", {
        sessionId: promptSession.sessionId,
        localPath: promptSession.localPath,
        remotePath: promptSession.remotePath,
        onProgress: channel,
      });
      const metadata = await stat(promptSession.localPath);
      markSynced(promptSession.id, normalizeMtime(metadata.mtime));
      setPromptSessionId(null);
    } catch (error) {
      markSyncing(promptSession.id, false);
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, [markSynced, markSyncing, promptSession, setPromptSessionId]);

  const handleDiscard = useCallback(async () => {
    if (!promptSession) return;
    setActionError(null);
    try {
      const metadata = await stat(promptSession.localPath);
      markSynced(promptSession.id, normalizeMtime(metadata.mtime));
    } catch {
      markSynced(promptSession.id, null);
    }
    setPromptSessionId(null);
  }, [markSynced, promptSession, setPromptSessionId]);

  const handleCancel = useCallback(() => {
    setActionError(null);
    setPromptSessionId(null);
    if (closingRequested) {
      clearCloseProtection();
    }
  }, [clearCloseProtection, closingRequested, setPromptSessionId]);

  return (
    <Dialog
      open={promptSession !== null}
      onClose={handleCancel}
      title={t("sftp.remoteEdit.title")}
      width="520px"
    >
      {promptSession && (
        <div className="cd-stack">
          <p>
            {closingRequested
              ? t("sftp.remoteEdit.closeMessage")
              : t("sftp.remoteEdit.message", { name: promptSession.fileName })}
          </p>

          {actionError && <div className="error-message">{actionError}</div>}

          <div className="cd-actions">
            <Button variant="ghost" onClick={handleCancel}>
              {t("sftp.remoteEdit.cancel")}
            </Button>
            <Button variant="secondary" onClick={() => void handleDiscard()}>
              {t("sftp.remoteEdit.discard")}
            </Button>
            <Button onClick={() => void handleUpload()} disabled={promptSession.syncing}>
              {promptSession.syncing
                ? t("sftp.remoteEdit.uploading", { name: promptSession.fileName })
                : t("sftp.remoteEdit.upload")}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
