// commands/ — Tauri IPC command handlers
//
// Each submodule exposes #[tauri::command] functions that are
// registered in main.rs via generate_handler![].

pub mod connection;
pub mod profile;
pub mod sftp;
pub mod terminal;
pub mod tunnel;
pub mod vault;
