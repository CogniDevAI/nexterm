// features/connection/useConnection.ts — Connection lifecycle hook
//
// Manages: connect, disconnect, host key verification, auth prompts

import { useCallback, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { tauriInvoke } from "../../lib/tauri";
import { useSessionStore } from "../../stores/sessionStore";
import { useProfileStore } from "../../stores/profileStore";
import { useTerminal } from "../terminal/useTerminal";
import { normalizeStartupCommands } from "./startupCommands";
import type {
  SessionId,
  SessionState,
  HostKeyVerificationRequest,
  HostKeyVerificationResponse,
  KeyboardInteractiveChallengeRequest,
  UserCredential,
} from "../../lib/types";

// Mirror the Rust SessionStateEvent enum
type SessionStateEvent =
  | { event: "stateChanged"; data: { sessionId: string; state: SessionState } }
  | { event: "hostKeyVerification"; data: HostKeyVerificationRequest }
  | { event: "keyboardInteractiveChallenge"; data: KeyboardInteractiveChallengeRequest };

interface UseConnectionReturn {
  connecting: boolean;
  connectingProfileId: string | null;
  connectError: string | null;
  hostKeyRequest: HostKeyVerificationRequest | null;
  mfaChallenge: KeyboardInteractiveChallengeRequest | null;
  needsPassword: boolean;
  pendingProfileId: string | null;
  pendingUser: UserCredential | null;
  connect: (profileId: string, password?: string, userId?: string) => Promise<void>;
  disconnect: (sessionId: string) => Promise<void>;
  respondHostKey: (response: HostKeyVerificationResponse) => void;
  respondMfa: (answers: string[]) => void;
  submitPassword: (password: string, remember: boolean) => void;
  cancelConnect: () => void;
  clearError: () => void;
  runStartupCommands: (sessionId: string, commands: string[]) => Promise<void>;
}

export function useConnection(): UseConnectionReturn {
  const { addSession, removeSession, updateSessionState, setStartupPreview } =
    useSessionStore();
  const { storeCredential } = useProfileStore();
  const { disposeSessionTerminals } = useTerminal();

  const [connecting, setConnecting] = useState(false);
  // H6 fix: Use a ref for the connecting guard so the double-connect check
  // always reads the latest value, avoiding stale closures in useCallback.
  const connectingProfileIdRef = useRef<string | null>(null);
  const [connectingProfileId, setConnectingProfileId] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [hostKeyRequest, setHostKeyRequest] =
    useState<HostKeyVerificationRequest | null>(null);
  const [mfaChallenge, setMfaChallenge] =
    useState<KeyboardInteractiveChallengeRequest | null>(null);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [pendingProfileId, setPendingProfileId] = useState<string | null>(null);
  const [pendingUser, setPendingUser] = useState<UserCredential | null>(null);
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);

  const connect = useCallback(
    async (profileId: string, password?: string, userId?: string) => {
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

      // Resolve which user to connect as (frontend mirrors backend logic)
      let resolvedUser: UserCredential | undefined;
      if (userId) {
        resolvedUser = profile.users.find((u) => u.id === userId);
      } else if (profile.users.length === 1) {
        resolvedUser = profile.users[0];
      } else {
        // Multiple users, no userId — backend will return UserSelectionRequired.
        // Let the caller handle the picker.
        const defaultUser = profile.users.find((u) => u.isDefault);
        resolvedUser = defaultUser ?? profile.users[0];
      }

      if (!resolvedUser) {
        setConnectError("User not found in profile");
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
      setPendingUser(resolvedUser);

      try {
        // Create Channel for session state events
        const onEvent = new Channel<SessionStateEvent>();
        onEvent.onmessage = (message) => {
          if (message.event === "stateChanged") {
            const { sessionId, state } = message.data;
            updateSessionState(sessionId, state);
            // Server-initiated disconnect: clean up session just as the
            // explicit disconnect button does. state may be the string
            // "disconnected" or an error object { error: { message } }.
            const isTerminal =
              state === "disconnected" ||
              (typeof state === "object" && "error" in state);
            if (isTerminal) {
              disposeSessionTerminals(sessionId);
              removeSession(sessionId);
            }
          } else if (message.event === "hostKeyVerification") {
            // The Rust side injects sessionId into the HK event so we can
            // respond immediately — without waiting for the connect promise.
            // This fixes the race where pendingSessionId is still null when
            // the user accepts the host key (C3 bug fix).
            if (message.data.sessionId) {
              setPendingSessionId(message.data.sessionId);
            }
            setHostKeyRequest(message.data);
          } else if (message.event === "keyboardInteractiveChallenge") {
            if (message.data.sessionId) {
              setPendingSessionId(message.data.sessionId);
            }
            setMfaChallenge(message.data);
          }
        };

        const sessionId = await tauriInvoke<SessionId>("connect", {
          profileId,
          userId: resolvedUser.id,
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
          userId: resolvedUser.id,
          username: resolvedUser.username,
          port: profile.port,
          connectedAt: Date.now(),
          state: "connected",
          terminals: [],
          activeTerminalId: null,
        });

        // Trigger startup commands preview if the profile has any
        const commands = normalizeStartupCommands(
          profile.startupCommands ?? [],
        );
        if (commands.length > 0) {
          setStartupPreview({
            sessionId,
            commands,
            profileName: profile.name,
          });
        }

        setConnecting(false);
        connectingProfileIdRef.current = null;
        setConnectingProfileId(null);
        setPendingProfileId(null);
        setPendingUser(null);
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
    [addSession, updateSessionState, setStartupPreview, removeSession, disposeSessionTerminals],
  );

  const disconnect = useCallback(
    async (sessionId: string) => {
      try {
        await tauriInvoke<void>("disconnect", { sessionId });
        // Dispose xterm.js instances BEFORE removing the session from the store
        // so any remaining references are cleaned up first (PTY leak fix).
        disposeSessionTerminals(sessionId);
        removeSession(sessionId);
      } catch (err) {
        setConnectError(String(err));
      }
    },
    [removeSession, disposeSessionTerminals],
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

  const respondMfa = useCallback(
    (answers: string[]) => {
      const sessionId = mfaChallenge?.sessionId ?? pendingSessionId;
      if (!sessionId) return;
      setMfaChallenge(null);
      void tauriInvoke<void>("respond_keyboard_interactive_challenge", {
        sessionId,
        responses: { responses: answers },
      }).catch((err) => {
        setConnectError(String(err));
      });
    },
    [mfaChallenge, pendingSessionId],
  );

  const submitPassword = useCallback(
    (password: string, remember: boolean) => {
      setNeedsPassword(false);
      if (pendingProfileId && pendingUser) {
        // If user wants to remember, store in keychain (with userId for vault key)
        if (remember && password.trim()) {
          void storeCredential(pendingProfileId, pendingUser.id, password);
        }
        void connect(pendingProfileId, password, pendingUser.id);
      }
    },
    [pendingProfileId, pendingUser, connect, storeCredential],
  );

  const cancelConnect = useCallback(() => {
    setConnecting(false);
    connectingProfileIdRef.current = null;
    setConnectingProfileId(null);
    setConnectError(null);
    setHostKeyRequest(null);
    setMfaChallenge(null);
    setNeedsPassword(false);
    setPendingProfileId(null);
    setPendingUser(null);
    setPendingSessionId(null);
  }, []);

  const clearError = useCallback(() => {
    setConnectError(null);
  }, []);

  // Inject startup commands into the active terminal PTY sequentially.
  // Guards against a missing activeTerminalId (acceptable — confirm latency
  // means the terminal is essentially always ready, but we never crash).
  const runStartupCommands = useCallback(
    async (sessionId: string, commands: string[]) => {
      // The preview can be confirmed before the PTY is ready: activeTerminalId
      // is null until TerminalTabs mounts, then a placeholder 'pending-<uuid>'
      // until onTerminalOpened swaps in the real id. Writing to either is a
      // no-op (null) or a backend reject (pending). Wait briefly for a real id.
      const isReady = (id: string | null | undefined): id is string =>
        !!id && !id.startsWith("pending-");

      let terminalId =
        useSessionStore.getState().sessions.get(sessionId)?.activeTerminalId;
      for (let i = 0; i < 50 && !isReady(terminalId); i++) {
        await new Promise((r) => setTimeout(r, 100));
        terminalId =
          useSessionStore.getState().sessions.get(sessionId)?.activeTerminalId;
      }
      if (!isReady(terminalId)) return;

      try {
        for (const cmd of commands) {
          const data = Array.from(new TextEncoder().encode(cmd + "\n"));
          await tauriInvoke<void>("write_terminal", {
            sessionId,
            terminalId,
            data,
          });
        }
      } catch (err) {
        console.error("Failed to run startup commands", err);
      }
    },
    [],
  );

  return {
    connecting,
    connectingProfileId,
    connectError,
    hostKeyRequest,
    mfaChallenge,
    needsPassword,
    pendingProfileId,
    pendingUser,
    connect,
    disconnect,
    respondHostKey,
    respondMfa,
    submitPassword,
    cancelConnect,
    clearError,
    runStartupCommands,
  };
}
