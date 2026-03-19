// features/tunnel/tunnel.types.ts — Tunnel-specific frontend types
//
// Extends shared types from lib/types.ts with UI-specific concerns.

import type { TunnelType, TunnelState } from "../../lib/types";

/** Form state for creating/editing a tunnel */
export interface TunnelFormData {
  tunnelType: TunnelType;
  bindHost: string;
  bindPort: string; // string for form input, validated to number
  targetHost: string;
  targetPort: string; // string for form input, validated to number
  label: string;
}

/** Validation errors for tunnel form fields */
export interface TunnelFormErrors {
  bindHost?: string;
  bindPort?: string;
  targetHost?: string;
  targetPort?: string;
}

/** Helper to get a display label for a tunnel state */
export function getTunnelStateLabel(state: TunnelState): string {
  if (state === "stopped") return "Stopped";
  if (state === "starting") return "Starting";
  if (typeof state === "object" && "active" in state) return "Active";
  if (typeof state === "object" && "error" in state) return "Error";
  return "Unknown";
}

/** Helper to get CSS class for tunnel state indicator */
export function getTunnelStateIndicator(state: TunnelState): string {
  if (state === "stopped") return "indicator-muted";
  if (state === "starting") return "indicator-warning";
  if (typeof state === "object" && "active" in state) return "indicator-success";
  if (typeof state === "object" && "error" in state) return "indicator-error";
  return "indicator-muted";
}

/** Get active connection count from tunnel state */
export function getActiveConnections(state: TunnelState): number {
  if (typeof state === "object" && "active" in state) {
    return state.active.connections;
  }
  return 0;
}

/** Get error message from tunnel state */
export function getTunnelErrorMessage(state: TunnelState): string | null {
  if (typeof state === "object" && "error" in state) {
    return state.error.message;
  }
  return null;
}

/** Validate a port number string — returns error message or null */
export function validatePort(value: string): string | null {
  if (!value.trim()) return "Port is required";
  const num = Number(value);
  if (!Number.isInteger(num)) return "Must be an integer";
  if (num < 1 || num > 65535) return "Port must be 1-65535";
  return null;
}

/** Validate a host string — returns error message or null */
export function validateHost(value: string): string | null {
  if (!value.trim()) return "Host is required";
  return null;
}

/** Validate entire tunnel form — returns errors object (empty = valid) */
export function validateTunnelForm(data: TunnelFormData): TunnelFormErrors {
  const errors: TunnelFormErrors = {};
  const bindHostErr = validateHost(data.bindHost);
  if (bindHostErr) errors.bindHost = bindHostErr;
  const bindPortErr = validatePort(data.bindPort);
  if (bindPortErr) errors.bindPort = bindPortErr;
  const targetHostErr = validateHost(data.targetHost);
  if (targetHostErr) errors.targetHost = targetHostErr;
  const targetPortErr = validatePort(data.targetPort);
  if (targetPortErr) errors.targetPort = targetPortErr;
  return errors;
}
