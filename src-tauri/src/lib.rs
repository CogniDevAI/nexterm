// lib.rs — Module declarations and re-exports for NexTerm
//
// The crate is organized into domain modules:
// - error: Unified error type (AppError)
// - state: Application state, session handles, shared types
// - profile: Connection profile types and persistence
// - ssh: SSH protocol operations (session, handler, terminal, sftp, tunnel, keys, known_hosts)
// - commands: Tauri IPC command handlers

pub mod commands;
pub mod error;
pub mod fs_secure;
pub mod profile;
pub mod ssh;
pub mod state;
pub mod vault;

use std::sync::Arc;
use std::time::{Duration, Instant};

use state::{AppState, AutoLockState};
use tokio::sync::Mutex;
use vault::{suspend_gap_detected, Vault};

/// How often the background auto-lock task wakes up to check idle/suspend.
const AUTO_LOCK_TICK: Duration = Duration::from_secs(15);

/// Tolerated scheduling jitter on top of [`AUTO_LOCK_TICK`] before a tick gap is
/// treated as an OS suspend. Generous enough to absorb a stalled/overloaded
/// event loop without false-locking, tight enough that real sleep (seconds to
/// hours of frozen wall time) is always caught.
const SUSPEND_SLACK: Duration = Duration::from_secs(20);

/// Lock the vault in `AppState` if it is currently unlocked, zeroizing the
/// derived key. Idempotent: safe to call when already locked or absent. This is
/// the single lock path shared by manual lock, idle timeout, and suspend.
async fn lock_vault(vault: &Mutex<Option<Vault>>) {
    let mut guard = vault.lock().await;
    if let Some(v) = guard.as_mut() {
        if v.is_unlocked() {
            v.lock(); // drops the Zeroizing<[u8;32]>, wiping key material
            tracing::info!("Vault auto-locked");
        }
    }
}

/// Spawn the background idle/suspend auto-lock task.
///
/// The task wakes every [`AUTO_LOCK_TICK`] and:
///  1. Detects OS suspend by the *monotonic-clock gap* heuristic. Tauri 2.10's
///     `RunEvent` exposes no OS suspend/resume signal (only winit-level
///     `Resumed`, which is a rendering-lifecycle event, not power management),
///     so we infer suspension: while the machine sleeps this task is frozen, so
///     on wake the elapsed gap between ticks far exceeds the tick interval.
///     `suspend_gap_detected` turns that into a defensive immediate lock.
///  2. Otherwise applies the idle-timeout policy via `AutoLockState`.
///
/// It does nothing while the vault is locked or absent (the lock call is a
/// no-op). Cleanly stops with the app: it is a detached task on Tauri's async
/// runtime which is torn down on exit — it never panics on shutdown because it
/// only ever locks (idempotent) and reads atomics/mutexes that outlive it for
/// the process lifetime via `Arc`.
pub fn spawn_auto_lock_task(vault: Arc<Mutex<Option<Vault>>>, auto_lock: Arc<AutoLockState>) {
    tauri::async_runtime::spawn(async move {
        let mut last_tick = Instant::now();
        loop {
            tokio::time::sleep(AUTO_LOCK_TICK).await;

            let now = Instant::now();
            let gap = now.saturating_duration_since(last_tick);
            last_tick = now;

            // Suspend heuristic: a tick gap far larger than expected means wall
            // time was lost while we were frozen — lock defensively, immediately.
            if suspend_gap_detected(gap, AUTO_LOCK_TICK, SUSPEND_SLACK) {
                tracing::info!("Detected clock gap of {gap:?} (likely OS suspend) — locking vault");
                lock_vault(&vault).await;
                // Treat resume as fresh: don't also fire an idle lock on the
                // same tick using a now-stale activity timestamp.
                continue;
            }

            // Idle policy. `should_lock_now` already honors timeout==0 (disabled).
            if auto_lock.should_lock_now(now) {
                lock_vault(&vault).await;
            }
        }
    });
}

/// Initialize and run the Tauri application
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let app_state = AppState::default();
    // Clone the shared handles the background auto-lock task needs *before*
    // `manage` takes ownership of the state.
    let vault_handle = Arc::clone(&app_state.vault);
    let auto_lock_handle = Arc::clone(&app_state.auto_lock);

    let mut builder = tauri::Builder::default();

    // Single-instance lock MUST be the first registered plugin (per the plugin
    // docs). It guarantees only one process touches profiles.json / vault.json,
    // preventing two instances from racing on those files (silent data loss).
    // A second launch surfaces the already-running window instead of spawning a
    // duplicate. Desktop-only: the plugin is not available on mobile targets.
    #[cfg(desktop)]
    {
        use tauri::Manager;
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .setup(move |app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_process::init())?;

            // Start the idle/suspend auto-lock watchdog.
            spawn_auto_lock_task(Arc::clone(&vault_handle), Arc::clone(&auto_lock_handle));
            Ok(())
        })
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            // Profile CRUD
            commands::profile::save_profile,
            commands::profile::load_profiles,
            commands::profile::delete_profile,
            commands::profile::get_profile,
            commands::profile::export_profiles,
            commands::profile::import_profiles,
            commands::profile::reorder_profiles,
            // Vault
            commands::vault::vault_status,
            commands::vault::vault_create,
            commands::vault::vault_unlock,
            commands::vault::vault_lock,
            commands::vault::vault_set_idle_timeout,
            commands::vault::vault_reset,
            commands::vault::store_credential,
            commands::vault::has_credential,
            commands::vault::delete_credential,
            // Connection
            commands::connection::connect,
            commands::connection::disconnect,
            commands::connection::list_sessions,
            commands::connection::get_session_state,
            commands::connection::respond_host_key_verification,
            commands::connection::respond_keyboard_interactive_challenge,
            commands::connection::test_connection,
            commands::connection::list_ssh_keys,
            // Terminal
            commands::terminal::open_terminal,
            commands::terminal::write_terminal,
            commands::terminal::resize_terminal,
            commands::terminal::close_terminal,
            // SFTP
            commands::sftp::sftp_open,
            commands::sftp::sftp_close,
            commands::sftp::sftp_list_dir,
            commands::sftp::sftp_stat,
            commands::sftp::sftp_mkdir,
            commands::sftp::sftp_delete,
            commands::sftp::sftp_rename,
            commands::sftp::sftp_upload,
            commands::sftp::sftp_download,
            commands::sftp::sftp_download_folder,
            commands::sftp::sftp_read_file,
            commands::sftp::sftp_write_file,
            commands::sftp::sftp_search,
            commands::sftp::sftp_cancel_transfer,
            commands::sftp::choose_application,
            commands::sftp::sftp_open_external,
            commands::sftp::sftp_open_with_app,
            commands::sftp::sftp_save_and_reveal,
            commands::sftp::list_local_dir,
            commands::sftp::open_local_file,
            commands::sftp::open_local_file_with,
            commands::sftp::local_read_text_file,
            commands::sftp::local_write_text_file,
            commands::sftp::sftp_remote_exists,
            commands::sftp::local_stat,
            commands::sftp::sftp_check_conflicts,
            // Tunnel
            commands::tunnel::create_tunnel,
            commands::tunnel::start_tunnel,
            commands::tunnel::stop_tunnel,
            commands::tunnel::remove_tunnel,
            commands::tunnel::list_tunnels,
            // SSH keygen
            commands::keygen::generate_ssh_key,
            // SSH exec
            commands::exec::ssh_exec,
            // Monitoring
            commands::monitoring::start_monitoring,
            commands::monitoring::stop_monitoring,
            commands::monitoring::kill_remote_process,
            // Docker (remote container management via SSH)
            commands::docker::docker_list_containers,
            commands::docker::docker_lifecycle_action,
            commands::docker::docker_get_logs,
            // Proxmox LXC management via SSH (pct CLI)
            commands::proxmox::proxmox_list_lxc,
            commands::proxmox::proxmox_lifecycle_action,
            commands::proxmox::proxmox_list_snapshots,
            commands::proxmox::proxmox_create_snapshot,
            commands::proxmox::proxmox_rollback_snapshot,
            commands::proxmox::proxmox_delete_snapshot,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
