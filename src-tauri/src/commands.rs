use tauri::{AppHandle, Manager, State};
use serde::{Deserialize, Serialize};
use crate::process_manager::ProcessManager;

#[tauri::command]
pub async fn spawn_process(
    app: AppHandle,
    state: State<'_, ProcessManager>,
    id: String,
    binary: String,
    args: Vec<String>,
) -> Result<(), String> {
    state.spawn(app, id, binary, args, None).await
}

#[tauri::command]
pub async fn send_stdin(
    state: State<'_, ProcessManager>,
    id: String,
    input: String,
) -> Result<(), String> {
    state.send_stdin(&id, &input).await
}

#[tauri::command]
pub async fn kill_process(
    state: State<'_, ProcessManager>,
    id: String,
) -> Result<(), String> {
    state.kill(&id).await
}

#[tauri::command]
pub async fn resolve_binary(app: AppHandle, binary_name: String) -> Result<String, String> {
    // Resolve sidecar resource path
    let resource_path = app
        .path()
        .resolve(
            format!("argyll/linux-x86_64/{}", binary_name),
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|e| e.to_string())?;

    // In a real app we'd switch based on target_os, but for Milestone 1 scaffolding we'll mock the linux path.
    Ok(resource_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn list_instruments(app: AppHandle, state: State<'_, ProcessManager>) -> Result<(), String> {
    // We would use spawn_process directly with instlist binary and parse JSON output.
    // For scaffolding, this is a placeholder.
    let binary = resolve_binary(app.clone(), "instlist".to_string()).await?;
    state.spawn(app, "instlist".to_string(), binary, vec![], None).await
}

#[derive(Debug, Deserialize, Serialize)]
pub struct TargenConfig {
    pub colour_space: String,
    pub patch_count: u32,
    pub white_patches: Option<u32>,
    pub black_patches: Option<u32>,
    pub basename: String,
    pub cwd: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct PrinttargConfig {
    pub instrument: String,   // One of: "i1", "p3", "CM", "SS", "20", "22", "41", "51"
    pub page_size: String,    // One of: "A4", "A4R", "A3", "A2", "Letter", "LetterR", "Legal", "4x6", "11x17", or "WWWxHHH"
    pub bit_depth: u8,        // 8 or 16
    pub dpi: u32,             // TIFF resolution, e.g. 100, 200, 300
    pub basename: String,     // Must match the .ti1 basename from Stage 1
    pub cwd: String,          // Working directory where the .ti1 file resides
}

pub fn build_targen_args(config: &TargenConfig) -> Vec<String> {
    let mut args = vec![
        "-v".to_string(),
        "-d".to_string(),
    ];
    
    if config.colour_space.to_lowercase() == "cmyk" {
        args.push("4".to_string());
    } else {
        args.push("2".to_string()); // Default to RGB
    }
    
    args.push("-f".to_string());
    args.push(config.patch_count.to_string());
    
    if let Some(white) = config.white_patches {
        args.push("-e".to_string());
        args.push(white.to_string());
    }
    
    if let Some(black) = config.black_patches {
        args.push("-B".to_string());
        args.push(black.to_string());
    }
    
    args.push(config.basename.clone());
    args
}

pub fn build_printtarg_args(config: &PrinttargConfig) -> Vec<String> {
    let mut args = vec![
        "-v".to_string(),
        "-u".to_string(),
        "-i".to_string(),
        config.instrument.clone(),
        "-p".to_string(),
        config.page_size.clone(),
    ];

    if config.bit_depth == 16 {
        args.push("-T".to_string());
    } else {
        args.push("-t".to_string());
    }
    args.push(config.dpi.to_string());

    args.push(config.basename.clone());
    args
}

#[tauri::command]
pub async fn run_targen(
    app: AppHandle,
    state: State<'_, ProcessManager>,
    config: TargenConfig,
) -> Result<(), String> {
    let binary = resolve_binary(app.clone(), "targen".to_string()).await?;
    let args = build_targen_args(&config);
    let id = format!("targen_{}", config.basename);
    
    let cwd = if config.cwd.trim().is_empty() {
        None
    } else {
        Some(config.cwd.clone())
    };
    
    println!("DEBUG RUN_TARGEN: binary='{}' args={:?} cwd={:?}", binary, args, cwd);
    
    state.spawn(app, id, binary, args, cwd).await
}

#[tauri::command]
pub async fn run_printtarg(
    app: AppHandle,
    state: State<'_, ProcessManager>,
    config: PrinttargConfig,
) -> Result<(), String> {
    let binary = resolve_binary(app.clone(), "printtarg".to_string()).await?;
    let args = build_printtarg_args(&config);
    let id = format!("printtarg_{}", config.basename);

    let cwd = if config.cwd.trim().is_empty() {
        None
    } else {
        Some(config.cwd.clone())
    };

    state.spawn(app, id, binary, args, cwd).await
}

#[tauri::command]
pub async fn read_file_base64(path: String) -> Result<String, String> {
    use std::fs;
    let bytes = fs::read(&path).map_err(|e| format!("Failed to read {}: {}", path, e))?;
    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ChartreadConfig {
    pub basename: String,
    pub cwd: String,
}

pub fn build_chartread_args(config: &ChartreadConfig) -> Vec<String> {
    vec![
        "-v".to_string(),
        "-u".to_string(),
        config.basename.clone(),
    ]
}

#[tauri::command]
pub async fn run_chartread(
    app: AppHandle,
    state: State<'_, ProcessManager>,
    config: ChartreadConfig,
) -> Result<(), String> {
    let binary = resolve_binary(app.clone(), "chartread".to_string()).await?;
    let args = build_chartread_args(&config);
    let id = format!("chartread_{}", config.basename);

    let cwd = if config.cwd.trim().is_empty() {
        None
    } else {
        Some(config.cwd.clone())
    };

    state.spawn(app, id, binary, args, cwd).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_targen_args_rgb() {
        let config = TargenConfig {
            colour_space: "rgb".to_string(),
            patch_count: 800,
            white_patches: Some(4),
            black_patches: None,
            basename: "my_profile".to_string(),
            cwd: "/tmp".to_string(),
        };
        let args = build_targen_args(&config);
        assert_eq!(args, vec!["-v", "-d", "2", "-f", "800", "-e", "4", "my_profile"]);
    }

    #[test]
    fn test_build_targen_args_cmyk() {
        let config = TargenConfig {
            colour_space: "cmyk".to_string(),
            patch_count: 1500,
            white_patches: None,
            black_patches: Some(8),
            basename: "cmyk_profile".to_string(),
            cwd: "/tmp".to_string(),
        };
        let args = build_targen_args(&config);
        assert_eq!(args, vec!["-v", "-d", "4", "-f", "1500", "-B", "8", "cmyk_profile"]);
    }

    #[test]
    fn test_build_printtarg_args_i1_a4_8bit() {
        let config = PrinttargConfig {
            instrument: "i1".to_string(),
            page_size: "A4".to_string(),
            bit_depth: 8,
            dpi: 100,
            basename: "my_profile".to_string(),
            cwd: "/tmp".to_string(),
        };
        let args = build_printtarg_args(&config);
        assert_eq!(args, vec!["-v", "-u", "-i", "i1", "-p", "A4", "-t", "100", "my_profile"]);
    }

    #[test]
    fn test_build_printtarg_args_cm_letter_16bit() {
        let config = PrinttargConfig {
            instrument: "CM".to_string(),
            page_size: "Letter".to_string(),
            bit_depth: 16,
            dpi: 300,
            basename: "cmyk_profile".to_string(),
            cwd: "/home/user".to_string(),
        };
        let args = build_printtarg_args(&config);
        assert_eq!(args, vec!["-v", "-u", "-i", "CM", "-p", "Letter", "-T", "300", "cmyk_profile"]);
    }

    #[test]
    fn test_build_printtarg_args_custom_page_size() {
        let config = PrinttargConfig {
            instrument: "SS".to_string(),
            page_size: "200x400".to_string(),
            bit_depth: 8,
            dpi: 150,
            basename: "custom_target".to_string(),
            cwd: "/tmp".to_string(),
        };
        let args = build_printtarg_args(&config);
        assert_eq!(args, vec!["-v", "-u", "-i", "SS", "-p", "200x400", "-t", "150", "custom_target"]);
    }

    #[test]
    fn test_build_chartread_args() {
        let config = ChartreadConfig {
            basename: "my_profile".to_string(),
            cwd: "/home/user".to_string(),
        };
        let args = build_chartread_args(&config);
        assert_eq!(args, vec!["-v", "-u", "my_profile"]);
    }
}
