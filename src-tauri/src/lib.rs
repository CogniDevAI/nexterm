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

use state::AppState;

/// Initialize and run the Tauri application
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_process::init())?;
            Ok(())
        })
        .manage(AppState::default())
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
            commands::connection::test_connection,
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
            commands::sftp::sftp_read_file,
            commands::sftp::sftp_search,
            commands::sftp::sftp_cancel_transfer,
            commands::sftp::choose_application,
            commands::sftp::sftp_open_external,
            commands::sftp::sftp_open_with_app,
            commands::sftp::sftp_save_and_reveal,
            commands::sftp::list_local_dir,
            commands::sftp::open_local_file,
            commands::sftp::open_local_file_with,
            // Tunnel
            commands::tunnel::create_tunnel,
            commands::tunnel::start_tunnel,
            commands::tunnel::stop_tunnel,
            commands::tunnel::remove_tunnel,
            commands::tunnel::list_tunnels,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
