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
    let settings = crate::settings::load_settings(app.clone()).unwrap_or_default();
    if let Some(dir) = settings.argyll_binary_dir {
        if !dir.trim().is_empty() {
            let custom_path = std::path::Path::new(&dir).join(&binary_name);
            if custom_path.exists() {
                return Ok(custom_path.to_string_lossy().to_string());
            }
        }
    }

    let platform = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => "linux-x86_64",
        ("windows", "x86_64") => "windows-x86_64",
        ("macos", "aarch64") => "macos-aarch64",
        ("macos", "x86_64") => "macos-x86_64",
        _ => "linux-x86_64",
    };

    let resource_path = app
        .path()
        .resolve(
            format!("argyll/{}/{}", platform, binary_name),
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|e| e.to_string())?;

    Ok(resource_path.to_string_lossy().to_string())
}

#[derive(Serialize)]
pub struct AppInfo {
    pub version: String,
    pub build_date: String,
}

#[tauri::command]
pub fn get_app_info() -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        build_date: env!("BUILD_DATE").to_string(),
    }
}

pub fn resolve_safe_cwd(app: &AppHandle, cwd_input: &str) -> Result<String, String> {
    if !cwd_input.trim().is_empty() {
        let p = std::path::Path::new(cwd_input.trim());
        if p.is_dir() {
            return Ok(p.to_string_lossy().to_string());
        }
    }

    app.path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .or_else(|_| app.path().app_data_dir())
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| format!("Failed to resolve default working directory: {}", e))
}

#[tauri::command]
pub fn get_default_working_dir(app: AppHandle) -> Result<String, String> {
    resolve_safe_cwd(&app, "")
}

#[tauri::command]
pub async fn detect_instruments(app: AppHandle, state: State<'_, ProcessManager>) -> Result<(), String> {
    let binary = resolve_binary(app.clone(), "instlist".to_string()).await?;
    state.spawn(app, "instlist".to_string(), binary, vec![], None).await
}

pub fn resolve_profile_extension(cwd: &str, basename: &str) -> (String, std::path::PathBuf) {
    let p_icc = std::path::Path::new(cwd).join(format!("{}.icc", basename));
    let p_icm = std::path::Path::new(cwd).join(format!("{}.icm", basename));

    if p_icm.exists() && !p_icc.exists() {
        ("icm".to_string(), p_icm)
    } else if p_icc.exists() {
        ("icc".to_string(), p_icc)
    } else {
        #[cfg(windows)]
        {
            ("icm".to_string(), p_icm)
        }
        #[cfg(not(windows))]
        {
            ("icc".to_string(), p_icc)
        }
    }
}

#[tauri::command]
pub fn get_profile_path(cwd: String, basename: String) -> String {
    let (_, path) = resolve_profile_extension(&cwd, &basename);
    path.to_string_lossy().to_string()
}

#[tauri::command]
pub async fn extract_gamut(
    app: AppHandle,
    state: State<'_, ProcessManager>,
    icc_path: String,
) -> Result<(), String> {
    let binary = resolve_binary(app.clone(), "iccgamut".to_string()).await?;
    let path = std::path::Path::new(&icc_path);
    let basename = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "profile".to_string());
    let parent_dir = path.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    
    // Auto-detect .icc vs .icm if the specified path does not exist directly
    let resolved_path = if path.exists() {
        icc_path.clone()
    } else {
        let alt = if icc_path.ends_with(".icc") {
            icc_path.replace(".icc", ".icm")
        } else if icc_path.ends_with(".icm") {
            icc_path.replace(".icm", ".icc")
        } else {
            icc_path.clone()
        };
        if std::path::Path::new(&alt).exists() {
            alt
        } else {
            icc_path.clone()
        }
    };

    let args = vec![
        "-v".to_string(),
        "-d".to_string(),
        "50.0".to_string(),
        resolved_path,
    ];
    let cwd = if parent_dir.is_empty() {
        resolve_safe_cwd(&app, "").ok()
    } else {
        Some(parent_dir)
    };
    
    let id = format!("iccgamut_{}", basename);
    state.spawn(app, id, binary, args, cwd).await
}

#[derive(Debug, Deserialize, Serialize)]
pub struct TargenConfig {
    pub colour_space: String,
    #[serde(default)]
    pub patch_count: u32,
    pub white_patches: Option<u32>,
    pub black_patches: Option<u32>,
    pub total_patches: Option<u32>,
    pub basename: String,
    pub cwd: String,
}

fn default_dpi() -> u32 {
    300
}

#[derive(Debug, Deserialize, Serialize)]
pub struct PrinttargConfig {
    pub instrument: String,   // One of: "i1", "p3", "CM", "SS", "20", "22", "41", "51"
    pub page_size: String,    // One of: "A4", "A4R", "A3", "A2", "Letter", "LetterR", "Legal", "4x6", "11x17", or "WWWxHHH"
    pub bit_depth: u8,        // 8 or 16
    #[serde(default = "default_dpi")]
    pub dpi: u32,             // TIFF resolution, defaults to 300 DPI
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
    
    let patches = if config.patch_count > 0 {
        config.patch_count
    } else {
        config.total_patches.unwrap_or(0)
    };
    
    if patches > 0 {
        args.push("-f".to_string());
        args.push(patches.to_string());
    }
    
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
    let cwd = Some(resolve_safe_cwd(&app, &config.cwd)?);
    
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
    let cwd = Some(resolve_safe_cwd(&app, &config.cwd)?);

    state.spawn(app, id, binary, args, cwd).await
}

#[tauri::command]
pub async fn read_file_base64(path: String) -> Result<String, String> {
    use std::fs;
    let bytes = fs::read(&path).map_err(|e| format!("Failed to read {}: {}", path, e))?;
    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

#[tauri::command]
pub async fn read_tiff_preview_png(path: String) -> Result<String, String> {
    use std::fs;
    use std::io::Cursor;
    use base64::Engine;
    use image::ImageFormat;

    let file_bytes = fs::read(&path).map_err(|e| format!("Failed to read {}: {}", path, e))?;
    let img = image::load_from_memory_with_format(&file_bytes, ImageFormat::Tiff)
        .map_err(|e| format!("Failed to decode TIFF {}: {}", path, e))?;

    let max_dim = std::cmp::max(img.width(), img.height());
    let processed_img = if max_dim > 1200 {
        img.resize(1200, 1200, image::imageops::FilterType::Lanczos3)
    } else {
        img
    };

    let mut png_bytes = Cursor::new(Vec::new());
    processed_img
        .write_to(&mut png_bytes, ImageFormat::Png)
        .map_err(|e| format!("Failed to encode PNG for {}: {}", path, e))?;

    Ok(base64::engine::general_purpose::STANDARD.encode(png_bytes.into_inner()))
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
    let cwd = Some(resolve_safe_cwd(&app, &config.cwd)?);

    state.spawn(app, id, binary, args, cwd).await
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ColprofConfig {
    pub algorithm: String,
    pub quality: String,
    pub intent: Option<String>,
    pub copyright: Option<String>,
    pub description: Option<String>,
    pub basename: String,
    pub cwd: String,
}

pub fn build_colprof_args(config: &ColprofConfig) -> Vec<String> {
    let mut args = vec![
        "-v".to_string(),
        "-a".to_string(),
        config.algorithm.clone(),
        "-q".to_string(),
        config.quality.clone(),
    ];

    if let Some(ref intent) = config.intent {
        if !intent.trim().is_empty() {
            args.push("-p".to_string());
            args.push(intent.clone());
        }
    }

    if let Some(ref cr) = config.copyright {
        if !cr.trim().is_empty() {
            args.push("-C".to_string());
            args.push(cr.clone());
        }
    }

    if let Some(ref desc) = config.description {
        if !desc.trim().is_empty() {
            args.push("-D".to_string());
            args.push(desc.clone());
        }
    }

    args.push(config.basename.clone());
    args
}

#[tauri::command]
pub async fn run_colprof(
    app: AppHandle,
    state: State<'_, ProcessManager>,
    config: ColprofConfig,
) -> Result<(), String> {
    let binary = resolve_binary(app.clone(), "colprof".to_string()).await?;
    let args = build_colprof_args(&config);
    let id = format!("colprof_{}", config.basename);
    let cwd = Some(resolve_safe_cwd(&app, &config.cwd)?);

    state.spawn(app, id, binary, args, cwd).await
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ProfcheckConfig {
    pub ti3_path: String,
    pub icc_path: String,
    pub cwd: String,
}

pub fn build_profcheck_args(config: &ProfcheckConfig) -> Vec<String> {
    vec![
        "-v".to_string(),
        "-k".to_string(),
        "-s".to_string(),
        config.ti3_path.clone(),
        config.icc_path.clone(),
    ]
}

#[tauri::command]
pub async fn run_profcheck(
    app: AppHandle,
    state: State<'_, ProcessManager>,
    mut config: ProfcheckConfig,
) -> Result<(), String> {
    let binary = resolve_binary(app.clone(), "profcheck".to_string()).await?;

    // Auto-detect .icc vs .icm if the specified icc_path does not exist directly
    if !std::path::Path::new(&config.icc_path).exists() {
        let alt = if config.icc_path.ends_with(".icc") {
            config.icc_path.replace(".icc", ".icm")
        } else if config.icc_path.ends_with(".icm") {
            config.icc_path.replace(".icm", ".icc")
        } else {
            config.icc_path.clone()
        };
        if std::path::Path::new(&alt).exists() {
            config.icc_path = alt;
        }
    }

    let args = build_profcheck_args(&config);
    let id = format!("profcheck_{}", config.ti3_path);
    let cwd = Some(resolve_safe_cwd(&app, &config.cwd)?);

    state.spawn(app, id, binary, args, cwd).await
}

#[tauri::command]
pub async fn get_windows_printers() -> Result<Vec<String>, String> {
    #[cfg(windows)]
    {
        crate::print::windows::get_printers().map(|list| list.into_iter().map(|p| p.name).collect())
    }
    #[cfg(not(windows))]
    {
        Err("Windows native printing is only supported on Windows.".to_string())
    }
}

#[tauri::command]
pub async fn print_target_windows(
    state: State<'_, crate::print::PrinterDevModeStore>,
    printer_name: String,
    tiff_path: String,
    options: Option<crate::print::PrintOptions>,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        crate::print::windows::print_target(&printer_name, &tiff_path, options.as_ref(), Some(&state))
    }
    #[cfg(not(windows))]
    {
        let _ = (state, printer_name, tiff_path, options);
        Err("Windows native printing is only supported on Windows.".to_string())
    }
}

#[tauri::command]
pub async fn get_cups_printers() -> Result<Vec<crate::print::Printer>, String> {
    #[cfg(unix)]
    {
        crate::print::unix::get_printers()
    }
    #[cfg(not(unix))]
    {
        Err("CUPS printing is only supported on macOS and Linux.".to_string())
    }
}

#[tauri::command]
pub async fn print_target_cups(
    printer_name: String,
    tiff_path: String,
    options: Option<crate::print::PrintOptions>,
) -> Result<(), String> {
    #[cfg(unix)]
    {
        crate::print::unix::print_target(
            &printer_name,
            &tiff_path,
            options.as_ref(),
        )
    }
    #[cfg(not(unix))]
    {
        let _ = (printer_name, tiff_path, options);
        Err("CUPS printing is only supported on macOS and Linux.".to_string())
    }
}

#[tauri::command]
pub async fn get_printers() -> Result<Vec<crate::print::Printer>, String> {
    #[cfg(windows)]
    {
        crate::print::windows::get_printers()
    }
    #[cfg(unix)]
    {
        crate::print::unix::get_printers()
    }
    #[cfg(not(any(windows, unix)))]
    {
        Err("Native printer enumeration is not supported on this platform.".to_string())
    }
}

#[tauri::command]
pub async fn get_printer_capabilities(
    printer_name: String,
) -> Result<crate::print::PrinterCapabilities, String> {
    #[cfg(windows)]
    {
        crate::print::windows::get_printer_capabilities(&printer_name)
    }
    #[cfg(unix)]
    {
        crate::print::unix::get_printer_capabilities(&printer_name)
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = printer_name;
        Err("Printer capabilities query is not supported on this platform.".to_string())
    }
}

#[tauri::command]
pub async fn show_printer_properties(
    state: State<'_, crate::print::PrinterDevModeStore>,
    printer_name: String,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        crate::print::windows::show_printer_properties(&printer_name, &state)
    }
    #[cfg(unix)]
    {
        let _ = (state, printer_name);
        Ok(())
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = (state, printer_name);
        Err("Printer properties dialog is not supported on this platform.".to_string())
    }
}

#[tauri::command]
pub async fn print_target_native(
    state: State<'_, crate::print::PrinterDevModeStore>,
    printer_name: String,
    tiff_path: String,
    options: Option<crate::print::PrintOptions>,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        crate::print::windows::print_target(
            &printer_name,
            &tiff_path,
            options.as_ref(),
            Some(&state),
        )
    }
    #[cfg(unix)]
    {
        let _ = state;
        crate::print::unix::print_target(
            &printer_name,
            &tiff_path,
            options.as_ref(),
        )
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = (state, printer_name, tiff_path, options);
        Err("Native raw printing is not supported on this platform.".to_string())
    }
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
            total_patches: None,
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
            total_patches: None,
            basename: "cmyk_profile".to_string(),
            cwd: "/tmp".to_string(),
        };
        let args = build_targen_args(&config);
        assert_eq!(args, vec!["-v", "-d", "4", "-f", "1500", "-B", "8", "cmyk_profile"]);
    }

    #[test]
    fn test_build_targen_args_total_patches_fallback() {
        let config = TargenConfig {
            colour_space: "rgb".to_string(),
            patch_count: 0,
            white_patches: None,
            black_patches: None,
            total_patches: Some(400),
            basename: "draft_profile".to_string(),
            cwd: "/tmp".to_string(),
        };
        let args = build_targen_args(&config);
        assert_eq!(args, vec!["-v", "-d", "2", "-f", "400", "draft_profile"]);
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

    #[test]
    fn test_build_colprof_args() {
        let config = ColprofConfig {
            quality: "h".to_string(),
            algorithm: "l".to_string(),
            intent: None,
            description: Some("My Profile".to_string()),
            copyright: Some("2026 ACME".to_string()),
            basename: "my_profile".to_string(),
            cwd: "/home/user".to_string(),
        };
        let args = build_colprof_args(&config);
        assert_eq!(
            args,
            vec!["-v", "-a", "l", "-q", "h", "-C", "2026 ACME", "-D", "My Profile", "my_profile"]
        );
    }

    #[test]
    fn test_build_profcheck_args() {
        let config = ProfcheckConfig {
            ti3_path: "my_profile.ti3".to_string(),
            icc_path: "my_profile.icc".to_string(),
            cwd: "/home/user".to_string(),
        };
        let args = build_profcheck_args(&config);
        assert_eq!(args, vec!["-v", "-k", "-s", "my_profile.ti3", "my_profile.icc"]);
    }
}
