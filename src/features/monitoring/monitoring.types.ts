// features/monitoring/monitoring.types.ts — Shared monitoring type aliases
//
// Re-exports store types for use in MonitoringPanel and related components
// without coupling them directly to the store import path.

export type {
  MetricSample,
  DiskEntry,
  MonitorProcessRow,
} from "../../stores/monitoringStore";
