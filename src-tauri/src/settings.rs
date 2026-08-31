use serde::{Deserialize, Serialize};
use std::fs;
use tauri::{AppHandle, Manager};

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq)]
pub struct ProfilingPreset {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub colour_space: String,
    pub patch_count: u32,
    pub white_patches: Option<u32>,
    pub black_patches: Option<u32>,
    pub instrument: String,
    pub page_size: String,
    pub bit_depth: u8,
    pub dpi: u32,
    pub colprof_algorithm: String,
    pub colprof_quality: String,
    pub colprof_intent: Option<String>,

    // Advanced Stage 1 fields
    #[serde(default)]
    pub grey_steps: Option<u32>,
    #[serde(default)]
    pub single_channel_steps: Option<u32>,
    #[serde(default)]
    pub neutral_steps: Option<u32>,
    #[serde(default)]
    pub preconditioning_profile: Option<String>,
    #[serde(default)]
    pub neutral_concentration: Option<f64>,
    #[serde(default)]
    pub ofps_high_quality: Option<bool>,
    #[serde(default)]
    pub ofps_adaptation: Option<f64>,
    #[serde(default)]
    pub full_spread_algorithm: Option<String>,
    #[serde(default)]
    pub total_ink_limit: Option<u32>,
    #[serde(default)]
    pub dark_emphasis: Option<f64>,
    #[serde(default)]
    pub device_power: Option<f64>,

    // Stage 2 fields
    #[serde(default)]
    pub random_seed: Option<u32>,
    #[serde(default)]
    pub no_randomize: Option<bool>,
}

#[derive(Debug, Deserialize, Serialize, Default, Clone)]
pub struct AppSettings {
    pub argyll_binary_dir: Option<String>,
    pub default_instrument: Option<String>,
    pub log_level: Option<String>,
    #[serde(default)]
    pub custom_presets: Vec<ProfilingPreset>,
}

pub fn get_default_presets() -> Vec<ProfilingPreset> {
    vec![
        ProfilingPreset {
            id: "preset-std-rgb".to_string(),
            name: "Standard RGB Photo (800 patches)".to_string(),
            description: Some("Recommended for standard fine-art and photographic RGB printing on inkjet printers.".to_string()),
            colour_space: "rgb".to_string(),
            patch_count: 800,
            white_patches: Some(4),
            black_patches: None,
            instrument: "i1".to_string(),
            page_size: "A4".to_string(),
            bit_depth: 8,
            dpi: 300,
            colprof_algorithm: "l".to_string(),
            colprof_quality: "m".to_string(),
            colprof_intent: None,
            grey_steps: None,
            single_channel_steps: None,
            neutral_steps: None,
            preconditioning_profile: None,
            neutral_concentration: None,
            ofps_high_quality: None,
            ofps_adaptation: None,
            full_spread_algorithm: None,
            total_ink_limit: None,
            dark_emphasis: None,
            device_power: None,
        },
        ProfilingPreset {
            id: "preset-hq-cmyk".to_string(),
            name: "High-Gamut CMYK Proofing (1500 patches)".to_string(),
            description: Some("High-precision CMYK press and RIP proofing profiling with deep shadow neutral boost.".to_string()),
            colour_space: "cmyk".to_string(),
            patch_count: 1500,
            white_patches: None,
            black_patches: Some(8),
            instrument: "i1".to_string(),
            page_size: "A3".to_string(),
            bit_depth: 16,
            dpi: 300,
            colprof_algorithm: "l".to_string(),
            colprof_quality: "h".to_string(),
            colprof_intent: None,
            grey_steps: None,
            single_channel_steps: None,
            neutral_steps: None,
            preconditioning_profile: None,
            neutral_concentration: None,
            ofps_high_quality: None,
            ofps_adaptation: None,
            full_spread_algorithm: None,
            total_ink_limit: Some(320),
            dark_emphasis: None,
            device_power: None,
        },
        ProfilingPreset {
            id: "preset-draft-rgb".to_string(),
            name: "Fast RGB Draft (400 patches)".to_string(),
            description: Some("Quick turn-around draft profiling for testing new media.".to_string()),
            colour_space: "rgb".to_string(),
            patch_count: 400,
            white_patches: None,
            black_patches: None,
            instrument: "i1".to_string(),
            page_size: "A4".to_string(),
            bit_depth: 8,
            dpi: 150,
            colprof_algorithm: "l".to_string(),
            colprof_quality: "l".to_string(),
            colprof_intent: None,
            grey_steps: None,
            single_channel_steps: None,
            neutral_steps: None,
            preconditioning_profile: None,
            neutral_concentration: None,
            ofps_high_quality: None,
            ofps_adaptation: None,
            full_spread_algorithm: None,
            total_ink_limit: None,
            dark_emphasis: None,
            device_power: None,
        },
        ProfilingPreset {
            id: "preset-ultra-rgb".to_string(),
            name: "Ultra Precision RGB (2500 patches)".to_string(),
            description: Some("Maximum precision lookup table profile for exhibition and master printmaking.".to_string()),
            colour_space: "rgb".to_string(),
            patch_count: 2500,
            white_patches: Some(6),
            black_patches: Some(6),
            instrument: "i1".to_string(),
            page_size: "A3".to_string(),
            bit_depth: 16,
            dpi: 300,
            colprof_algorithm: "l".to_string(),
            colprof_quality: "u".to_string(),
            colprof_intent: None,
            grey_steps: None,
            single_channel_steps: None,
            neutral_steps: None,
            preconditioning_profile: None,
            neutral_concentration: None,
            ofps_high_quality: Some(true),
            ofps_adaptation: None,
            full_spread_algorithm: None,
            total_ink_limit: None,
            dark_emphasis: None,
            device_power: None,
        },
    ]
}

pub fn parse_log_level_filter(level: Option<&str>) -> log::LevelFilter {
    match level.map(|s| s.trim().to_lowercase()).as_deref() {
        Some("error") => log::LevelFilter::Error,
        Some("warn") | Some("warning") => log::LevelFilter::Warn,
        Some("info") => log::LevelFilter::Info,
        Some("debug") => log::LevelFilter::Debug,
        Some("trace") => log::LevelFilter::Trace,
        _ => {
            if cfg!(debug_assertions) {
                log::LevelFilter::Debug
            } else {
                log::LevelFilter::Info
            }
        }
    }
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
    fs::write(path.join("settings.json"), json).map_err(|e| e.to_string())?;

    // Dynamically apply the log level immediately at runtime
    let filter = parse_log_level_filter(settings.log_level.as_deref());
    log::set_max_level(filter);
    log::info!("Applied log level filter: {:?}", filter);

    Ok(())
}

#[tauri::command]
pub fn get_all_presets(app: AppHandle) -> Vec<ProfilingPreset> {
    let mut presets = get_default_presets();
    let settings = load_settings(app).unwrap_or_default();
    presets.extend(settings.custom_presets);
    presets
}

#[tauri::command]
pub fn save_preset(app: AppHandle, preset: ProfilingPreset) -> Result<Vec<ProfilingPreset>, String> {
    let mut settings = load_settings(app.clone()).unwrap_or_default();
    if let Some(pos) = settings.custom_presets.iter().position(|p| p.id == preset.id) {
        settings.custom_presets[pos] = preset;
    } else {
        settings.custom_presets.push(preset);
    }
    save_settings(app.clone(), settings)?;
    Ok(get_all_presets(app))
}

#[tauri::command]
pub fn delete_preset(app: AppHandle, id: String) -> Result<Vec<ProfilingPreset>, String> {
    let mut settings = load_settings(app.clone()).unwrap_or_default();
    settings.custom_presets.retain(|p| p.id != id);
    save_settings(app.clone(), settings)?;
    Ok(get_all_presets(app))
}

#[tauri::command]
pub fn export_preset_json(preset: ProfilingPreset) -> Result<String, String> {
    serde_json::to_string_pretty(&preset).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn import_preset_json(json: String) -> Result<ProfilingPreset, String> {
    let preset: ProfilingPreset = serde_json::from_str::<ProfilingPreset>(&json)
        .map_err(|e| format!("Invalid preset format: {}", e))?;
    
    if preset.name.trim().is_empty() {
        return Err("Preset name cannot be empty".to_string());
    }
    if preset.name.len() > 200 {
        return Err("Preset name is too long (max 200 characters)".to_string());
    }
    if let Some(ref desc) = preset.description {
        if desc.len() > 500 {
            return Err("Preset description is too long (max 500 characters)".to_string());
        }
    }
    if preset.dpi < 72 || preset.dpi > 2400 {
        return Err("Preset DPI out of allowed range (72 - 2400)".to_string());
    }
    Ok(preset)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_default_presets() {
        let defaults = get_default_presets();
        assert_eq!(defaults.len(), 4);
        assert_eq!(defaults[0].id, "preset-std-rgb");
        assert_eq!(defaults[0].colour_space, "rgb");
        assert_eq!(defaults[0].patch_count, 800);
        assert_eq!(defaults[1].colour_space, "cmyk");
        assert_eq!(defaults[1].patch_count, 1500);
    }

    #[test]
    fn test_import_preset_validation_name_length() {
        let mut preset = get_default_presets()[0].clone();
        preset.name = "a".repeat(201);
        let json = serde_json::to_string(&preset).unwrap();
        assert!(import_preset_json(json).is_err());
    }

    #[test]
    fn test_import_preset_validation_dpi() {
        let mut preset = get_default_presets()[0].clone();
        preset.dpi = 10;
        let json = serde_json::to_string(&preset).unwrap();
        assert!(import_preset_json(json).is_err());
    }

    #[test]
    fn test_preset_json_export_and_import() {
        let preset = ProfilingPreset {
            id: "custom-test".to_string(),
            name: "Custom Test Preset".to_string(),
            description: Some("Test description".to_string()),
            colour_space: "rgb".to_string(),
            patch_count: 1200,
            white_patches: Some(2),
            black_patches: Some(4),
            instrument: "i1".to_string(),
            page_size: "A4".to_string(),
            bit_depth: 16,
            dpi: 300,
            colprof_algorithm: "l".to_string(),
            colprof_quality: "h".to_string(),
            colprof_intent: None,
            grey_steps: Some(16),
            single_channel_steps: Some(8),
            neutral_steps: Some(10),
            preconditioning_profile: Some("/profiles/precond.icc".to_string()),
            neutral_concentration: Some(0.75),
            ofps_high_quality: Some(true),
            ofps_adaptation: Some(0.80),
            full_spread_algorithm: Some("t".to_string()),
            total_ink_limit: Some(320),
            dark_emphasis: Some(1.5),
            device_power: Some(1.2),
            random_seed: Some(42),
            no_randomize: Some(false),
        };

        let json = export_preset_json(preset.clone()).expect("Export failed");
        let imported = import_preset_json(json).expect("Import failed");
        assert_eq!(preset, imported);
    }

    #[test]
    fn test_parse_log_level_filter() {
        assert_eq!(parse_log_level_filter(Some("error")), log::LevelFilter::Error);
        assert_eq!(parse_log_level_filter(Some("ERROR")), log::LevelFilter::Error);
        assert_eq!(parse_log_level_filter(Some("warn")), log::LevelFilter::Warn);
        assert_eq!(parse_log_level_filter(Some("warning")), log::LevelFilter::Warn);
        assert_eq!(parse_log_level_filter(Some("info")), log::LevelFilter::Info);
        assert_eq!(parse_log_level_filter(Some("debug")), log::LevelFilter::Debug);
        assert_eq!(parse_log_level_filter(Some("trace")), log::LevelFilter::Trace);
        assert_eq!(parse_log_level_filter(Some("  Info  ")), log::LevelFilter::Info);

        if cfg!(debug_assertions) {
            assert_eq!(parse_log_level_filter(None), log::LevelFilter::Debug);
            assert_eq!(parse_log_level_filter(Some("unknown")), log::LevelFilter::Debug);
        } else {
            assert_eq!(parse_log_level_filter(None), log::LevelFilter::Info);
            assert_eq!(parse_log_level_filter(Some("unknown")), log::LevelFilter::Info);
        }
    }
}
