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

pub fn get_binary_candidates(binary_name: &str) -> Vec<String> {
    if cfg!(windows) && !binary_name.to_lowercase().ends_with(".exe") {
        vec![format!("{}.exe", binary_name), binary_name.to_string()]
    } else {
        vec![binary_name.to_string()]
    }
}

#[tauri::command]
pub async fn resolve_binary(app: AppHandle, binary_name: String) -> Result<String, String> {
    let settings = crate::settings::load_settings(app.clone()).unwrap_or_default();
    let candidates = get_binary_candidates(&binary_name);

    if let Some(dir) = settings.argyll_binary_dir {
        if !dir.trim().is_empty() {
            let base_dir = std::path::Path::new(&dir);
            for name in &candidates {
                let custom_path = base_dir.join(name);
                if custom_path.exists() {
                    return Ok(custom_path.to_string_lossy().to_string());
                }
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

    for name in &candidates {
        if let Ok(resource_path) = app.path().resolve(
            format!("argyll/{}/{}", platform, name),
            tauri::path::BaseDirectory::Resource,
        ) {
            if resource_path.exists() {
                return Ok(resource_path.to_string_lossy().to_string());
            }
        }
    }

    let primary_name = &candidates[0];
    let resource_path = app
        .path()
        .resolve(
            format!("argyll/{}/{}", platform, primary_name),
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
pub fn get_log_path(app: AppHandle) -> Result<String, String> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("Failed to resolve log dir: {}", e))?;
    Ok(log_dir.join("iccery.log").to_string_lossy().to_string())
}

#[tauri::command]
pub fn open_log_dir(app: AppHandle) -> Result<(), String> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("Failed to resolve log dir: {}", e))?;
    
    std::fs::create_dir_all(&log_dir).map_err(|e| format!("Failed to create log dir: {}", e))?;

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&log_dir)
            .spawn()
            .map_err(|e| format!("Failed to open log folder: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&log_dir)
            .spawn()
            .map_err(|e| format!("Failed to open log folder: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&log_dir)
            .spawn()
            .map_err(|e| format!("Failed to open log folder: {}", e))?;
    }

    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Ti2Metadata {
    pub basename: String,
    pub cwd: String,
    pub instrument: Option<String>,
    pub patch_count: Option<u32>,
    pub colorant_count: Option<u32>,
    pub pages: Option<u32>,
    pub has_ti1: bool,
    pub has_ti2: bool,
}

#[tauri::command]
pub fn parse_ti2_header(app: AppHandle, file_path: String) -> Result<Ti2Metadata, String> {
    let path = std::path::PathBuf::from(&file_path);
    if !path.exists() {
        return Err(format!("File does not exist: {}", file_path));
    }

    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read target file: {}", e))?;

    let parent = path.parent().unwrap_or_else(|| std::path::Path::new(""));
    let file_stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let cwd = parent.to_string_lossy().to_string();
    let basename = file_stem.to_string();

    let ti1_path = parent.join(format!("{}.ti1", basename));
    let ti2_path = parent.join(format!("{}.ti2", basename));

    let mut instrument: Option<String> = None;
    let mut patch_count: Option<u32> = None;
    let mut colorant_count: Option<u32> = None;
    let mut pages: Option<u32> = None;

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("TARGET_INSTRUMENT") {
            let parts: Vec<&str> = trimmed.split_whitespace().collect();
            if parts.len() >= 2 {
                instrument = Some(parts[1].trim_matches('"').to_string());
            }
        } else if trimmed.starts_with("NUMBER_OF_FIELDS") {
            let parts: Vec<&str> = trimmed.split_whitespace().collect();
            if parts.len() >= 2 {
                colorant_count = parts[1].parse::<u32>().ok();
            }
        } else if trimmed.starts_with("NUMBER_OF_SETS") {
            let parts: Vec<&str> = trimmed.split_whitespace().collect();
            if parts.len() >= 2 {
                patch_count = parts[1].parse::<u32>().ok();
            }
        } else if trimmed.starts_with("NUMBER_OF_PAGES") || trimmed.starts_with("PAGES") {
            let parts: Vec<&str> = trimmed.split_whitespace().collect();
            if parts.len() >= 2 {
                pages = parts[1].parse::<u32>().ok();
            }
        }
    }

    Ok(Ti2Metadata {
        basename,
        cwd,
        instrument,
        patch_count,
        colorant_count,
        pages,
        has_ti1: ti1_path.exists(),
        has_ti2: ti2_path.exists(),
    })
}

#[tauri::command]
pub async fn select_existing_target(
    app: AppHandle,
    default_dir: Option<String>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let mut builder = app.dialog().file().add_filter("ArgyllCMS Target Files (.ti1, .ti2)", &["ti1", "ti2"]);
    if let Some(ref dir) = default_dir {
        if !dir.trim().is_empty() {
            builder = builder.set_directory(std::path::PathBuf::from(dir));
        }
    }

    let (tx, rx) = tokio::sync::oneshot::channel();
    builder.pick_file(move |file_path| {
        let res = file_path.map(|p| p.to_string());
        let _ = tx.send(res);
    });

    rx.await.map_err(|e| format!("Dialog channel error: {}", e))
}

#[tauri::command]
pub async fn select_target_file(
    app: AppHandle,
    default_dir: Option<String>,
    default_name: Option<String>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let mut builder = app.dialog().file().add_filter("ArgyllCMS Target", &["ti1"]);
    if let Some(ref dir) = default_dir {
        if !dir.trim().is_empty() {
            builder = builder.set_directory(std::path::PathBuf::from(dir));
        }
    }
    if let Some(ref name) = default_name {
        if !name.trim().is_empty() {
            let filename = if name.to_lowercase().ends_with(".ti1") {
                name.to_string()
            } else {
                format!("{}.ti1", name)
            };
            builder = builder.set_file_name(filename);
        }
    }

    let (tx, rx) = tokio::sync::oneshot::channel();
    builder.save_file(move |file_path| {
        let res = file_path.map(|p| p.to_string());
        let _ = tx.send(res);
    });

    rx.await.map_err(|e| format!("Dialog channel error: {}", e))
}

#[tauri::command]
pub async fn select_directory(
    app: AppHandle,
    default_dir: Option<String>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let mut builder = app.dialog().file();
    if let Some(ref dir) = default_dir {
        if !dir.trim().is_empty() {
            builder = builder.set_directory(std::path::PathBuf::from(dir));
        }
    }

    let (tx, rx) = tokio::sync::oneshot::channel();
    builder.pick_folder(move |folder_path| {
        let res = folder_path.map(|p| p.to_string());
        let _ = tx.send(res);
    });

    rx.await.map_err(|e| format!("Dialog channel error: {}", e))
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

#[derive(Serialize)]
pub struct StageStatus {
    pub stage1_complete: bool,
    pub stage2_complete: bool,
    pub stage3_complete: bool,
    pub stage4_complete: bool,
    pub profile_path: Option<String>,
}

#[tauri::command]
pub fn verify_stage_artefacts(cwd: String, basename: String) -> StageStatus {
    if cwd.trim().is_empty() || basename.trim().is_empty() {
        return StageStatus {
            stage1_complete: false,
            stage2_complete: false,
            stage3_complete: false,
            stage4_complete: false,
            profile_path: None,
        };
    }

    let base_path = std::path::Path::new(&cwd);
    let ti1 = base_path.join(format!("{}.ti1", basename)).exists();
    let ti2 = base_path.join(format!("{}.ti2", basename)).exists();
    let ti3 = base_path.join(format!("{}.ti3", basename)).exists();
    let (_, prof_p) = resolve_profile_extension(&cwd, &basename);
    let prof_exists = prof_p.exists();

    StageStatus {
        stage1_complete: ti1,
        stage2_complete: ti2,
        stage3_complete: ti3,
        stage4_complete: prof_exists,
        profile_path: if prof_exists { Some(prof_p.to_string_lossy().to_string()) } else { None },
    }
}

#[tauri::command]
pub fn get_profile_path(cwd: String, basename: String) -> String {
    let (_, path) = resolve_profile_extension(&cwd, &basename);
    path.to_string_lossy().to_string()
}

pub fn build_iccgamut_args(resolved_path: &str) -> Vec<String> {
    vec![
        "-v".to_string(),
        "-d".to_string(),
        "10".to_string(),
        resolved_path.to_string(),
    ]
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

    let args = build_iccgamut_args(&resolved_path);
    let cwd = if parent_dir.is_empty() {
        resolve_safe_cwd(&app, "").ok()
    } else {
        Some(parent_dir)
    };
    
    let id = format!("iccgamut_{}", basename);
    state.spawn(app, id, binary, args, cwd).await
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct TargenConfig {
    pub colour_space: String,
    #[serde(default)]
    pub patch_count: u32,
    pub white_patches: Option<u32>,
    pub black_patches: Option<u32>,
    pub total_patches: Option<u32>,
    pub basename: String,
    pub cwd: String,

    // Advanced Stage 1 options
    pub grey_steps: Option<u32>,                  // -g
    pub single_channel_steps: Option<u32>,        // -s
    pub neutral_steps: Option<u32>,               // -n
    pub preconditioning_profile: Option<String>,  // -c
    pub neutral_concentration: Option<f64>,       // -N
    pub ofps_high_quality: Option<bool>,          // -G
    pub ofps_adaptation: Option<f64>,             // -A
    pub full_spread_algorithm: Option<String>,    // "ofps"|"t"|"r"|"R"|"q"|"Q"|"i"|"I"
    pub total_ink_limit: Option<u32>,             // -l
    pub dark_emphasis: Option<f64>,               // -V
    pub device_power: Option<f64>,                // -p
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
    pub custom_label: Option<String>, // Custom chart label / description metadata string (-d)
    pub basename: String,     // Must match the .ti1 basename from Stage 1
    pub cwd: String,          // Working directory where the .ti1 file resides
}

pub fn build_targen_args(config: &TargenConfig) -> Vec<String> {
    let mut args = vec![
        "-v".to_string(),
        "-d".to_string(),
    ];
    
    let is_cmyk = config.colour_space.to_lowercase() == "cmyk";
    if is_cmyk {
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

    if let Some(grey) = config.grey_steps {
        if grey > 0 {
            args.push("-g".to_string());
            args.push(grey.to_string());
        }
    }

    if let Some(single) = config.single_channel_steps {
        if single > 0 {
            args.push("-s".to_string());
            args.push(single.to_string());
        }
    }

    if let Some(ref precond) = config.preconditioning_profile {
        let trimmed = precond.trim();
        if !trimmed.is_empty() {
            args.push("-c".to_string());
            args.push(trimmed.to_string());
        }
    }

    if let Some(neutral) = config.neutral_steps {
        if neutral > 0 {
            args.push("-n".to_string());
            args.push(neutral.to_string());
        }
    }

    if let Some(conc) = config.neutral_concentration {
        if (conc - 0.50).abs() > 0.001 {
            args.push("-N".to_string());
            args.push(format!("{:.2}", conc));
        }
    }

    if let Some(true) = config.ofps_high_quality {
        args.push("-G".to_string());
    }

    if let Some(adapt) = config.ofps_adaptation {
        args.push("-A".to_string());
        args.push(format!("{:.2}", adapt));
    }

    if let Some(ref algo) = config.full_spread_algorithm {
        match algo.as_str() {
            "t" => args.push("-t".to_string()),
            "r" => args.push("-r".to_string()),
            "R" => args.push("-R".to_string()),
            "q" => args.push("-q".to_string()),
            "Q" => args.push("-Q".to_string()),
            "i" => args.push("-i".to_string()),
            "I" => args.push("-I".to_string()),
            _ => {} // default is OFPS (no flag needed)
        }
    }

    if is_cmyk {
        if let Some(limit) = config.total_ink_limit {
            if limit > 0 && limit <= 400 {
                args.push("-l".to_string());
                args.push(limit.to_string());
            }
        }
    }

    if let Some(dark) = config.dark_emphasis {
        if (dark - 1.0).abs() > 0.001 {
            args.push("-V".to_string());
            args.push(format!("{:.2}", dark));
        }
    }

    if let Some(power) = config.device_power {
        if (power - 1.0).abs() > 0.001 && power > 0.0 {
            args.push("-p".to_string());
            args.push(format!("{:.2}", power));
        }
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

    if let Some(ref label) = config.custom_label {
        args.push("-d".to_string());
        args.push(label.clone());
    }

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
    pub port: Option<String>,
}

pub fn build_chartread_args(config: &ChartreadConfig) -> Vec<String> {
    let mut args = vec![
        "-v".to_string(),
        "-u".to_string(),
    ];

    if let Some(ref port) = config.port {
        if !port.trim().is_empty() {
            args.push("-c".to_string());
            args.push(port.trim().to_string());
        }
    }

    args.push(config.basename.clone());
    args
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
pub struct AverageConfig {
    pub inputs: Vec<String>,
    pub output: String,
    pub cwd: String,
}

pub fn build_average_args(config: &AverageConfig) -> Vec<String> {
    let mut args = vec!["-v".to_string()];
    for input in &config.inputs {
        args.push(input.clone());
    }
    args.push(config.output.clone());
    args
}

#[tauri::command]
pub async fn run_average(
    app: AppHandle,
    state: State<'_, ProcessManager>,
    config: AverageConfig,
) -> Result<(), String> {
    let binary = resolve_binary(app.clone(), "average".to_string()).await?;
    let args = build_average_args(&config);
    let id = format!("average_{}", config.output);
    let cwd = Some(resolve_safe_cwd(&app, &config.cwd)?);

    state.spawn(app, id, binary, args, cwd).await
}

fn sanitize_basename(basename: &str) -> Result<String, String> {
    let name = basename.trim();
    if name.is_empty() {
        return Err("basename is empty".to_string());
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("basename must not contain path separators".to_string());
    }
    Ok(name.to_string())
}

pub fn snapshot_ti3_filename(basename: &str, pass_index: u32) -> Result<String, String> {
    if pass_index == 0 {
        return Err("pass_index must be 1-based".to_string());
    }
    let name = sanitize_basename(basename)?;
    Ok(format!("{}_pass{}.ti3", name, pass_index))
}

/// Copy `{cwd}/{basename}.ti3` to `{cwd}/{basename}_pass{N}.ti3` and remove the
/// canonical file so Stage 4 stays locked until Finish (#109 / #110).
#[tauri::command]
pub fn snapshot_ti3(cwd: String, basename: String, pass_index: u32) -> Result<String, String> {
    let dest_name = snapshot_ti3_filename(&basename, pass_index)?;
    let name = sanitize_basename(&basename)?;
    let dir = std::path::Path::new(&cwd);
    if !dir.is_dir() {
        return Err(format!("working directory does not exist: {}", cwd));
    }
    let src = dir.join(format!("{}.ti3", name));
    if !src.is_file() {
        return Err(format!("measurement file not found: {}", src.display()));
    }
    let dest = dir.join(&dest_name);
    std::fs::copy(&src, &dest).map_err(|e| format!("failed to snapshot .ti3: {}", e))?;
    std::fs::remove_file(&src)
        .map_err(|e| format!("failed to remove canonical .ti3 after snapshot: {}", e))?;
    Ok(dest_name)
}

/// Copy a pass file (relative name) back to `{cwd}/{basename}.ti3`.
#[tauri::command]
pub fn promote_ti3(cwd: String, source: String, basename: String) -> Result<(), String> {
    let name = sanitize_basename(&basename)?;
    let src_name = source.trim();
    if src_name.is_empty()
        || src_name.contains('/')
        || src_name.contains('\\')
        || src_name.contains("..")
    {
        return Err("source filename is invalid".to_string());
    }
    let dir = std::path::Path::new(&cwd);
    let src = dir.join(src_name);
    if !src.is_file() {
        return Err(format!("source measurement file not found: {}", src.display()));
    }
    let dest = dir.join(format!("{}.ti3", name));
    std::fs::copy(&src, &dest).map_err(|e| format!("failed to promote .ti3: {}", e))?;
    Ok(())
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
pub async fn get_printers() -> Result<Vec<crate::print::Printer>, String> {
    #[cfg(windows)]
    {
        crate::print::windows::get_printers()
    }
    #[cfg(target_os = "macos")]
    {
        crate::print::macos::get_printers()
    }
    #[cfg(all(unix, not(target_os = "macos")))]
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
    #[cfg(target_os = "macos")]
    {
        crate::print::macos::get_printer_capabilities(&printer_name)
    }
    #[cfg(all(unix, not(target_os = "macos")))]
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
    #[cfg(target_os = "macos")]
    {
        let _ = state;
        crate::print::macos::show_printer_properties(&printer_name)
    }
    #[cfg(all(unix, not(target_os = "macos")))]
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
    #[cfg(target_os = "macos")]
    {
        let _ = state;
        crate::print::macos::print_target(
            &printer_name,
            &tiff_path,
            options.as_ref(),
        )
    }
    #[cfg(all(unix, not(target_os = "macos")))]
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
    fn test_build_iccgamut_args() {
        let args = build_iccgamut_args("/path/to/profile.icc");
        assert_eq!(args, vec!["-v", "-d", "10", "/path/to/profile.icc"]);
    }

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
        };
        let args = build_targen_args(&config);
        assert_eq!(args, vec!["-v", "-d", "2", "-f", "400", "draft_profile"]);
    }

    #[test]
    fn test_build_targen_args_all_advanced_flags() {
        let config = TargenConfig {
            colour_space: "cmyk".to_string(),
            patch_count: 1200,
            white_patches: Some(4),
            black_patches: Some(4),
            total_patches: None,
            basename: "adv_target".to_string(),
            cwd: "/home/user".to_string(),
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
        };
        let args = build_targen_args(&config);
        assert_eq!(
            args,
            vec![
                "-v", "-d", "4",
                "-f", "1200",
                "-e", "4",
                "-B", "4",
                "-g", "16",
                "-s", "8",
                "-c", "/profiles/precond.icc",
                "-n", "10",
                "-N", "0.75",
                "-G",
                "-A", "0.80",
                "-t",
                "-l", "320",
                "-V", "1.50",
                "-p", "1.20",
                "adv_target"
            ]
        );
    }

    #[test]
    fn test_build_targen_args_rgb_ignores_ink_limit() {
        let config = TargenConfig {
            colour_space: "rgb".to_string(),
            patch_count: 800,
            white_patches: None,
            black_patches: None,
            total_patches: None,
            basename: "rgb_target".to_string(),
            cwd: "/tmp".to_string(),
            grey_steps: None,
            single_channel_steps: None,
            neutral_steps: None,
            preconditioning_profile: None,
            neutral_concentration: None,
            ofps_high_quality: None,
            ofps_adaptation: None,
            full_spread_algorithm: None,
            total_ink_limit: Some(300), // Should be ignored for RGB
            dark_emphasis: None,
            device_power: None,
        };
        let args = build_targen_args(&config);
        assert!(!args.contains(&"-l".to_string()));
    }

    #[test]
    fn test_build_printtarg_args_i1_a4_8bit() {
        let config = PrinttargConfig {
            instrument: "i1".to_string(),
            page_size: "A4".to_string(),
            bit_depth: 8,
            dpi: 100,
            custom_label: None,
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
            custom_label: None,
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
            custom_label: None,
            basename: "custom_target".to_string(),
            cwd: "/tmp".to_string(),
        };
        let args = build_printtarg_args(&config);
        assert_eq!(args, vec!["-v", "-u", "-i", "SS", "-p", "200x400", "-t", "150", "custom_target"]);
    }

    #[test]
    fn test_build_printtarg_args_with_custom_label() {
        let config = PrinttargConfig {
            instrument: "i1".to_string(),
            page_size: "A4".to_string(),
            bit_depth: 8,
            dpi: 300,
            custom_label: Some("ICCery - Pro900 - Luster - 29/08/2026 12:00".to_string()),
            basename: "my_profile".to_string(),
            cwd: "/tmp".to_string(),
        };
        let args = build_printtarg_args(&config);
        assert_eq!(
            args,
            vec![
                "-v",
                "-u",
                "-i",
                "i1",
                "-p",
                "A4",
                "-d",
                "ICCery - Pro900 - Luster - 29/08/2026 12:00",
                "-t",
                "300",
                "my_profile"
            ]
        );
    }

    #[test]
    fn test_build_chartread_args_auto() {
        let config = ChartreadConfig {
            basename: "my_profile".to_string(),
            cwd: "/home/user".to_string(),
            port: None,
        };
        let args = build_chartread_args(&config);
        assert_eq!(args, vec!["-v", "-u", "my_profile"]);
    }

    #[test]
    fn test_build_chartread_args_empty_port() {
        let config = ChartreadConfig {
            basename: "my_profile".to_string(),
            cwd: "/home/user".to_string(),
            port: Some("".to_string()),
        };
        let args = build_chartread_args(&config);
        assert_eq!(args, vec!["-v", "-u", "my_profile"]);
    }

    #[test]
    fn test_build_chartread_args_with_port() {
        let config = ChartreadConfig {
            basename: "my_profile".to_string(),
            cwd: "/home/user".to_string(),
            port: Some("1".to_string()),
        };
        let args = build_chartread_args(&config);
        assert_eq!(args, vec!["-v", "-u", "-c", "1", "my_profile"]);
    }

    #[test]
    fn test_build_average_args() {
        let config = AverageConfig {
            inputs: vec!["pass1.ti3".to_string(), "pass2.ti3".to_string()],
            output: "avg.ti3".to_string(),
            cwd: "/home/user".to_string(),
        };
        let args = build_average_args(&config);
        assert_eq!(args, vec!["-v", "pass1.ti3", "pass2.ti3", "avg.ti3"]);
    }

    #[test]
    fn test_build_average_args_pass_files() {
        let config = AverageConfig {
            inputs: vec!["job_pass1.ti3".to_string(), "job_pass2.ti3".to_string()],
            output: "job.ti3".to_string(),
            cwd: "/home/user".to_string(),
        };
        let args = build_average_args(&config);
        assert_eq!(args, vec!["-v", "job_pass1.ti3", "job_pass2.ti3", "job.ti3"]);
    }

    #[test]
    fn test_snapshot_ti3_filename() {
        assert_eq!(snapshot_ti3_filename("foo", 1).unwrap(), "foo_pass1.ti3");
        assert_eq!(snapshot_ti3_filename("foo", 2).unwrap(), "foo_pass2.ti3");
        assert!(snapshot_ti3_filename("foo", 0).is_err());
        assert!(snapshot_ti3_filename("../x", 1).is_err());
        assert!(snapshot_ti3_filename("a/b", 1).is_err());
    }

    #[test]
    fn test_snapshot_and_promote_ti3_roundtrip() {
        let dir = std::env::temp_dir().join(format!(
            "iccery_ti3_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let canonical = dir.join("job.ti3");
        std::fs::write(&canonical, b"PASS1").unwrap();
        let cwd = dir.to_string_lossy().to_string();
        let name = snapshot_ti3(cwd.clone(), "job".to_string(), 1).unwrap();
        assert_eq!(name, "job_pass1.ti3");
        assert!(!canonical.exists(), "canonical .ti3 must be removed after snapshot");
        assert_eq!(std::fs::read(dir.join("job_pass1.ti3")).unwrap(), b"PASS1");

        std::fs::write(dir.join("job_pass2.ti3"), b"PASS2").unwrap();
        let name2 = snapshot_ti3_filename("job", 2).unwrap();
        assert_eq!(name2, "job_pass2.ti3");
        assert!(dir.join("job_pass1.ti3").exists(), "pass 1 must survive pass 2");

        promote_ti3(cwd, name, "job".to_string()).unwrap();
        assert_eq!(std::fs::read(&canonical).unwrap(), b"PASS1");
        let _ = std::fs::remove_dir_all(&dir);
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

    #[test]
    fn test_get_binary_candidates() {
        let candidates = get_binary_candidates("targen");
        if cfg!(windows) {
            assert_eq!(candidates, vec!["targen.exe", "targen"]);
        } else {
            assert_eq!(candidates, vec!["targen"]);
        }

        let candidates_exe = get_binary_candidates("targen.exe");
        assert_eq!(candidates_exe, vec!["targen.exe"]);
    }
}
