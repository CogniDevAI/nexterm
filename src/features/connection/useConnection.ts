// features/connection/useConnection.ts — Connection lifecycle hook
//
// Manages: connect, disconnect, host key verification, auth prompts

import { useCallback, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { tauriInvoke } from "../../lib/tauri";
import { useSessionStore } from "../../stores/sessionStore";
import { useProfileStore } from "../../stores/profileStore";
import type {
  SessionId,
  SessionState,
  HostKeyVerificationRequest,
  HostKeyVerificationResponse,
} from "../../lib/types";

// Mirror the Rust SessionStateEvent enum
type SessionStateEvent =
  | { event: "stateChanged"; data: { sessionId: string; state: SessionState } }
  | { event: "hostKeyVerification"; data: HostKeyVerificationRequest };

interface UseConnectionReturn {
  connecting: boolean;
  connectingProfileId: string | null;
  connectError: string | null;
  hostKeyRequest: HostKeyVerificationRequest | null;
  needsPassword: boolean;
  pendingProfileId: string | null;
  connect: (profileId: string, password?: string) => Promise<void>;
  disconnect: (sessionId: string) => Promise<void>;
  respondHostKey: (response: HostKeyVerificationResponse) => void;
  submitPassword: (password: string, remember: boolean) => void;
  cancelConnect: () => void;
  clearError: () => void;
}

export function useConnection(): UseConnectionReturn {
  const { addSession, removeSession, updateSessionState } = useSessionStore();
  const { storeCredential } = useProfileStore();

  const [connecting, setConnecting] = useState(false);
  // H6 fix: Use a ref for the connecting guard so the double-connect check
  // always reads the latest value, avoiding stale closures in useCallback.
  const connectingProfileIdRef = useRef<string | null>(null);
  const [connectingProfileId, setConnectingProfileId] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [hostKeyRequest, setHostKeyRequest] =
    useState<HostKeyVerificationRequest | null>(null);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [pendingProfileId, setPendingProfileId] = useState<string | null>(null);
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);

  const connect = useCallback(
    async (profileId: string, password?: string) => {
      // Read profiles from Zustand's latest state — NOT the closure.
      // When called immediately after saveProfile (e.g. "Save & Connect"),
      // the closure's `profiles` is stale (captured before the store update).
      // getState() always returns the current value.
      const currentProfiles = useProfileStore.getState().profiles;
      const profile = currentProfiles.find((p) => p.id === profileId);
      if (!profile) {
        setConnectError("Profile not found");
        return;
      }

      // Double-connect guard: use ref for latest value (H6 stale closure fix)
      if (connectingProfileIdRef.current === profileId) {
        return;
      }

      connectingProfileIdRef.current = profileId;
      setConnecting(true);
      setConnectingProfileId(profileId);
      setConnectError(null);
      setHostKeyRequest(null);
      setNeedsPassword(false);
      setPendingProfileId(profileId);

      try {
        // Create Channel for session state events
        const onEvent = new Channel<SessionStateEvent>();
        onEvent.onmessage = (message) => {
          if (message.event === "stateChanged") {
            const { sessionId, state } = message.data;
            updateSessionState(sessionId, state);
          } else if (message.event === "hostKeyVerification") {
            // The Rust side injects sessionId into the HK event so we can
            // respond immediately — without waiting for the connect promise.
            // This fixes the race where pendingSessionId is still null when
            // the user accepts the host key (C3 bug fix).
            if (message.data.sessionId) {
              setPendingSessionId(message.data.sessionId);
            }
            setHostKeyRequest(message.data);
          }
        };

        const sessionId = await tauriInvoke<SessionId>("connect", {
          profileId,
          password: password ?? null,
          onEvent,
        });

        setPendingSessionId(sessionId);

        // Add session to store
        addSession({
          id: sessionId,
          profileId,
          profileName: profile.name,
          host: `${profile.host}:${profile.port}`,
          username: profile.username,
          port: profile.port,
          connectedAt: Date.now(),
          state: "connected",
          terminals: [],
          activeTerminalId: null,
        });

        setConnecting(false);
        connectingProfileIdRef.current = null;
        setConnectingProfileId(null);
        setPendingProfileId(null);
      } catch (err) {
        const msg = String(err);
        if (msg.includes("Password or passphrase required")) {
          setNeedsPassword(true);
          // Clear the double-connect guard so submitPassword → connect() isn't blocked.
          // We keep connecting=true (visual indicator) but allow the same profileId
          // to be passed to connect() again with the password.
          connectingProfileIdRef.current = null;
        } else {
          setConnectError(msg);
          setConnecting(false);
          connectingProfileIdRef.current = null;
          setConnectingProfileId(null);
        }
      }
    },
    [addSession, updateSessionState],
  );

  const disconnect = useCallback(
    async (sessionId: string) => {
      try {
        await tauriInvoke<void>("disconnect", { sessionId });
        removeSession(sessionId);
      } catch (err) {
        setConnectError(String(err));
      }
    },
    [removeSession],
  );

  const respondHostKey = useCallback(
    (response: HostKeyVerificationResponse) => {
      // Use session ID from the HK event payload (primary, always available)
      // with fallback to pendingSessionId (set after connect resolves).
      // This ensures we can respond even when the connect promise is still blocked.
      const sessionId = hostKeyRequest?.sessionId ?? pendingSessionId;
      if (!sessionId) return;
      setHostKeyRequest(null);
      void tauriInvoke<void>("respond_host_key_verification", {
        sessionId,
        response,
      }).catch((err) => {
        setConnectError(String(err));
      });
    },
    [hostKeyRequest, pendingSessionId],
  );

  const submitPassword = useCallback(
    (password: string, remember: boolean) => {
      setNeedsPassword(false);
      if (pendingProfileId) {
        // If user wants to remember, store in keychain
        if (remember && password.trim()) {
          void storeCredential(pendingProfileId, password);
        }
        void connect(pendingProfileId, password);
      }
    },
    [pendingProfileId, connect, storeCredential],
  );

  const cancelConnect = useCallback(() => {
    setConnecting(false);
    connectingProfileIdRef.current = null;
    setConnectingProfileId(null);
    setConnectError(null);
    setHostKeyRequest(null);
    setNeedsPassword(false);
    setPendingProfileId(null);
    setPendingSessionId(null);
  }, []);

  const clearError = useCallback(() => {
    setConnectError(null);
  }, []);

  return {
    connecting,
    connectingProfileId,
    connectError,
    hostKeyRequest,
    needsPassword,
    pendingProfileId,
    connect,
    disconnect,
    respondHostKey,
    submitPassword,
    cancelConnect,
    clearError,
  };
}
