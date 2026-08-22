mod commands;
mod events;
mod process_manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(process_manager::ProcessManager::new())
        .invoke_handler(tauri::generate_handler![
            commands::spawn_process,
            commands::send_stdin,
            commands::kill_process,
            commands::resolve_binary,
            commands::list_instruments,
            commands::run_targen,
            commands::run_printtarg,
            commands::read_file_base64,
            commands::run_chartread,
            commands::run_colprof,
            commands::run_profcheck,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
