// ssh/monitoring.rs — Remote system monitoring sampler task
//
// This module implements the per-session monitoring loop:
// - Spawns a tokio task that periodically runs a combined command on the remote host
// - Parses output via metrics_parser
// - Computes deltas (CPU%, net bps) across consecutive ticks
// - Emits MetricEvent over a Tauri Channel
// - Respects the session CancellationToken for clean shutdown

// Populated in WU3
