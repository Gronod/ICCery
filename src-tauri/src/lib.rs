mod commands;
mod events;
mod process_manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(process_manager::ProcessManager::new())
        .invoke_handler(tauri::generate_handler![
            commands::spawn_process,
            commands::send_stdin,
            commands::kill_process,
            commands::resolve_binary,
            commands::list_instruments
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
