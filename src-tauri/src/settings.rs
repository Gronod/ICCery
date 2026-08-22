use serde::{Deserialize, Serialize};
use std::fs;
use tauri::{AppHandle, Manager};

#[derive(Debug, Deserialize, Serialize, Default, Clone)]
pub struct AppSettings {
    pub argyll_binary_dir: Option<String>,
    pub default_instrument: Option<String>,
}

#[tauri::command]
pub fn load_settings(app: AppHandle) -> Result<AppSettings, String> {
    let path = app.path().app_data_dir().unwrap().join("settings.json");
    if let Ok(data) = fs::read_to_string(path) {
        Ok(serde_json::from_str(&data).unwrap_or_default())
    } else {
        Ok(AppSettings::default())
    }
}

#[tauri::command]
pub fn save_settings(app: AppHandle, settings: AppSettings) -> Result<(), String> {
    let path = app.path().app_data_dir().unwrap();
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(&settings).unwrap();
    fs::write(path.join("settings.json"), json).map_err(|e| e.to_string())
}
