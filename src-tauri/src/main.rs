// main.rs — Tauri application entry point
//
// Delegates to lib.rs for application setup and execution.
// Prevents an extra console window on Windows in release.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    nexterm_lib::run();
}
