use tauri::Manager;

mod commands;
mod events;
mod print;
mod process_manager;
mod settings;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("iccery".into()),
                    }),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
                ])
                .level(if cfg!(debug_assertions) {
                    log::LevelFilter::Debug
                } else {
                    log::LevelFilter::Info
                })
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                .build(),
        )
        .manage(process_manager::ProcessManager::new())
        .manage(print::PrinterDevModeStore::new())
        .invoke_handler(tauri::generate_handler![
            commands::spawn_process,
            commands::get_app_info,
            commands::get_default_working_dir,
            commands::get_log_path,
            commands::open_log_dir,
            commands::parse_ti2_header,
            commands::select_existing_target,
            commands::select_target_file,
            commands::select_directory,
            commands::send_stdin,
            commands::kill_process,
            commands::kill_all_processes,
            commands::resolve_binary,
            commands::detect_instruments,
            commands::get_profile_path,
            commands::verify_stage_artefacts,
            commands::extract_gamut,
            commands::run_targen,
            commands::run_printtarg,
            commands::read_file_base64,
            commands::read_tiff_preview_png,
            commands::run_chartread,
            commands::snapshot_ti3,
            commands::promote_ti3,
            commands::run_average,
            commands::run_colprof,
            commands::run_profcheck,
            commands::get_printers,
            commands::get_printer_capabilities,
            commands::show_printer_properties,
            commands::print_target_native,
            settings::load_settings,
            settings::save_settings,
            settings::get_all_presets,
            settings::save_preset,
            settings::delete_preset,
            settings::export_preset_json,
            settings::import_preset_json,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            match event {
                tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. } => {
                    let pm = app_handle.state::<process_manager::ProcessManager>();
                    tauri::async_runtime::block_on(async {
                        pm.kill_all().await;
                    });
                }
                tauri::RunEvent::WindowEvent {
                    event: tauri::WindowEvent::CloseRequested { .. },
                    ..
                } => {
                    let pm = app_handle.state::<process_manager::ProcessManager>();
                    tauri::async_runtime::block_on(async {
                        pm.kill_all().await;
                    });
                }
                _ => {}
            }
        });
}
