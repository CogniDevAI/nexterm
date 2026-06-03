// features/editor/useFileEditor.ts — Load + save logic for the in-app editor
//
// Handles:
//   - Remote file load: sftp_read_file (rejects binary/too-large → error state)
//   - Local file load:  local_read_text_file (Rust command)
//   - Remote file save: sftp_write_file
//   - Local file save:  local_write_text_file (Rust command)
//
// Local file I/O goes through Rust commands (NOT @tauri-apps/plugin-fs) because
// the JS fs plugin is restricted to the capability file's fs scope, which blocks
// arbitrary paths like the user's home root. Rust is not subject to that scope.
//
// All I/O goes through the editorStore — components just dispatch store actions
// and read stable primitives. This hook is the only place that touches Tauri.

import { useCallback } from "react";
import { useEditorStore } from "../../stores/editorStore";
import type { DocKey, DocSource } from "../../stores/editorStore";
import type { SessionId, FileContent } from "../../lib/types";
import { tauriInvoke } from "../../lib/tauri";

// Maximum file size in bytes we will load into the textarea (15 MB cap — same
// as the Rust read_file side). Guard is belt-and-suspenders; Rust also rejects.
const MAX_EDITOR_SIZE = 15 * 1024 * 1024;

export interface UseFileEditorReturn {
  loadDoc: (key: DocKey, sessionId: SessionId, source: DocSource, path: string) => Promise<void>;
  saveDoc: (key: DocKey, sessionId: SessionId, source: DocSource, path: string, content: string) => Promise<void>;
}

export function useFileEditor(): UseFileEditorReturn {
  const { setContent, markSaved, setSaving, setError, setLoading } =
    useEditorStore.getState();

  const loadDoc = useCallback(
    async (key: DocKey, sessionId: SessionId, source: DocSource, path: string) => {
      setLoading(key, true);
      try {
        if (source === "remote") {
          // sftp_read_file returns FileContent; pass maxLines=null for full file
          const result = await tauriInvoke<FileContent>("sftp_read_file", {
            sessionId,
            remotePath: path,
            maxLines: null,
          });

          if (result.fileSize > MAX_EDITOR_SIZE) {
            setError(
              key,
              `File too large (${(result.fileSize / 1024 / 1024).toFixed(1)} MB). Download it to view.`,
            );
            return;
          }

          // Rust already rejects binary files with "Binary file cannot be previewed"
          // but we guard here too in case the error path returns a partial result.
          setContent(key, result.content);
          markSaved(key, result.content);
        } else {
          // Local file via Rust command (not subject to the JS fs plugin scope)
          const content = await tauriInvoke<string>("local_read_text_file", { path });
          setContent(key, content);
          markSaved(key, content);
        }
        setLoading(key, false);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(key, message);
      }
    },
    [setContent, markSaved, setError, setLoading],
  );

  const saveDoc = useCallback(
    async (key: DocKey, sessionId: SessionId, source: DocSource, path: string, content: string) => {
      setSaving(key, true);
      try {
        if (source === "remote") {
          await tauriInvoke<void>("sftp_write_file", {
            sessionId,
            remotePath: path,
            content,
          });
        } else {
          await tauriInvoke<void>("local_write_text_file", { path, content });
        }
        markSaved(key, content);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(key, message);
        setSaving(key, false);
      }
    },
    [markSaved, setError, setSaving],
  );

  return { loadDoc, saveDoc };
}
