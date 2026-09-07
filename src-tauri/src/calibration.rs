//! Printer linearization via ArgyllCMS `printcal` / `applycal` / `targen` (#224).
//!
//! All orchestration stays in the proprietary host. Argyll binaries are invoked
//! as isolated subprocesses — never linked.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};

use crate::commands::{resolve_binary, resolve_safe_cwd};
use crate::process_manager::ProcessManager;

pub const CAL_PREFIX: &str = "CAL_";
pub const DEFAULT_STEPS: u32 = 21;
pub const MIN_STEPS: u32 = 11;
pub const MAX_STEPS: u32 = 51;
pub const DEFAULT_STALE_DAYS: u32 = 30;
pub const PROJECT_STATE_FILENAME: &str = "iccery-calibration.json";

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct PrintcalTargetConfig {
    pub colour_space: String,
    #[serde(default = "default_steps")]
    pub steps_per_channel: u32,
    pub ink_limit_exploration: Option<u32>,
    pub channels: Option<String>,
    #[serde(default)]
    pub white_patches: Option<u32>,
    #[serde(default)]
    pub neutral_emphasis: bool,
    pub basename: String,
    pub cwd: String,
}

fn default_steps() -> u32 {
    DEFAULT_STEPS
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct PrintcalConfig {
    pub ti3_basename: String,
    pub cwd: String,
    pub output_cal: Option<String>,
    pub previous_cal: Option<String>,
    #[serde(default)]
    pub force_overwrite: bool,
    #[serde(default)]
    pub no_ink_limit: bool,
    #[serde(default)]
    pub verify: bool,
    pub total_ink_limit: Option<f64>,
    #[serde(default)]
    pub channel_limits: Vec<ChannelLimit>,
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq)]
pub struct ChannelLimit {
    pub channel: String,
    pub percent: f64,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ApplycalConfig {
    pub cal_path: String,
    pub input_path: String,
    pub output_path: Option<String>,
    #[serde(default)]
    pub unapply: bool,
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq)]
pub struct CalCurve {
    pub channel: String,
    pub points: Vec<[f64; 2]>,
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq)]
pub struct CalMetadata {
    pub path: String,
    pub filename: String,
    pub color_rep: Option<String>,
    pub created: Option<String>,
    pub description: Option<String>,
    pub modified_ms: u128,
    pub age_days: f64,
    pub ink_limits: Vec<ChannelLimit>,
    pub total_ink_limit: Option<f64>,
    pub curves: Vec<CalCurve>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct CalResult {
    pub cal_path: String,
    pub stdout: String,
    pub stderr: String,
    pub ink_limits: Vec<ChannelLimit>,
    pub total_ink_limit: Option<f64>,
    pub recommended_power: Option<f64>,
    pub metadata: Option<CalMetadata>,
    pub message: String,
}

#[derive(Debug, Deserialize, Serialize, Clone, Default)]
pub struct ProjectCalibrationState {
    pub cal_path: Option<String>,
    pub apply_enabled: bool,
    pub printer_name: Option<String>,
    pub colour_space: Option<String>,
    pub created: Option<String>,
    pub cal_basename: Option<String>,
    pub ink_limit_overrides: Vec<ChannelLimit>,
    pub total_ink_override: Option<f64>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ApplycalResult {
    pub output_path: String,
    pub stdout: String,
    pub message: String,
}

pub fn clamp_steps(steps: u32) -> u32 {
    steps.clamp(MIN_STEPS, MAX_STEPS)
}

pub fn calibration_basename(profile_basename: &str) -> String {
    let trimmed = profile_basename.trim();
    let base = trimmed
        .strip_prefix(CAL_PREFIX)
        .unwrap_or(trimmed)
        .trim();
    let base = if base.is_empty() { "printer" } else { base };
    format!("{CAL_PREFIX}{base}")
}

pub fn is_calibration_basename(basename: &str) -> bool {
    basename.trim().starts_with(CAL_PREFIX)
}

/// Build `targen` arguments for a short per-channel calibration chart.
///
/// RGB: `-d2 -s{N} -g{N}` (and optional `-e` white patches).
/// CMYK: `-d4 -s{N} -g{N}` plus optional `-l` TAC exploration.
pub fn build_calibration_targen_args(config: &PrintcalTargetConfig) -> Result<Vec<String>, String> {
    let basename = sanitize_cal_basename(&config.basename)?;
    let steps = clamp_steps(config.steps_per_channel);
    let is_cmyk = config.colour_space.eq_ignore_ascii_case("cmyk");

    let mut args = vec!["-v".to_string(), "-d".to_string()];
    args.push(if is_cmyk { "4".to_string() } else { "2".to_string() });

    args.push("-s".to_string());
    args.push(steps.to_string());
    args.push("-g".to_string());
    args.push(steps.to_string());

    if config.neutral_emphasis {
        args.push("-n".to_string());
        args.push(steps.to_string());
    }

    if let Some(white) = config.white_patches {
        if white > 0 {
            args.push("-e".to_string());
            args.push(white.to_string());
        }
    } else {
        args.push("-e".to_string());
        args.push("4".to_string());
    }

    if is_cmyk {
        if let Some(limit) = config.ink_limit_exploration {
            if (200..=400).contains(&limit) {
                args.push("-l".to_string());
                args.push(limit.to_string());
            }
        }
    }

    // Full-spread patches are not useful on a calibration wedge.
    args.push("-f".to_string());
    args.push("0".to_string());

    args.push(basename);
    Ok(args)
}

pub fn build_printcal_args(config: &PrintcalConfig) -> Result<Vec<String>, String> {
    let basename = sanitize_cal_basename(&config.ti3_basename)?;
    let mut args = vec!["-v".to_string(), "-e".to_string()];

    if config.no_ink_limit {
        args.push("-I".to_string());
    }
    if config.verify {
        args.push("-z".to_string());
    }
    if let Some(ref prev) = config.previous_cal {
        let trimmed = prev.trim();
        if !trimmed.is_empty() {
            args.push("-a".to_string());
            args.push(trimmed.to_string());
        }
    }
    if let Some(tac) = config.total_ink_limit {
        if tac > 0.0 {
            args.push("-m".to_string());
            args.push(format!("{tac:.1}"));
        }
    }
    for limit in &config.channel_limits {
        let ch = limit.channel.trim();
        if ch.is_empty() {
            continue;
        }
        let flag = format!("-x{}", ch.chars().next().unwrap_or('C'));
        args.push(flag);
        args.push(format!("{:.1}", limit.percent));
    }

    let output = config
        .output_cal
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("{basename}.cal"));
    args.push("-o".to_string());
    args.push(output);
    args.push(basename);
    Ok(args)
}

pub fn build_applycal_args(config: &ApplycalConfig) -> Result<Vec<String>, String> {
    let cal = config.cal_path.trim();
    let input = config.input_path.trim();
    if cal.is_empty() {
        return Err("calibration file path is empty".to_string());
    }
    if input.is_empty() {
        return Err("input profile path is empty".to_string());
    }
    let mut args = vec!["-v".to_string()];
    if config.unapply {
        args.push("-u".to_string());
    } else {
        args.push("-a".to_string());
    }
    args.push(cal.to_string());
    args.push(input.to_string());
    if let Some(ref out) = config.output_path {
        let trimmed = out.trim();
        if !trimmed.is_empty() {
            args.push(trimmed.to_string());
        }
    }
    Ok(args)
}

pub fn sanitize_cal_basename(basename: &str) -> Result<String, String> {
    let name = basename.trim();
    if name.is_empty() {
        return Err("basename is empty".to_string());
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("basename must not contain path separators".to_string());
    }
    Ok(name.to_string())
}

pub fn parse_printcal_stdout(stdout: &str) -> (Vec<ChannelLimit>, Option<f64>, Option<f64>) {
    let mut limits = Vec::new();
    let mut total = None;
    let mut power = None;

    for raw in stdout.lines() {
        let line = raw.trim();
        let lower = line.to_ascii_lowercase();

        if lower.contains("ideal power") || lower.contains("device power") || lower.contains("power value") {
            if let Some(v) = first_number(line) {
                power = Some(v);
            }
        }

        if lower.contains("total") && (lower.contains("ink") || lower.contains("tac") || lower.contains("limit")) {
            if let Some(v) = first_number(line) {
                total = Some(v);
            }
            continue;
        }

        if let Some(ch) = channel_from_limit_line(line) {
            if let Some(v) = first_number(line) {
                limits.push(ChannelLimit {
                    channel: ch,
                    percent: v,
                });
            }
        }
    }

    (limits, total, power)
}

fn channel_from_limit_line(line: &str) -> Option<String> {
    let t = line.trim();
    let letters = ["Cyan", "Magenta", "Yellow", "Black", "Red", "Green", "Blue"];
    let shorts = ["C", "M", "Y", "K", "R", "G", "B"];
    for (full, short) in letters.iter().zip(shorts) {
        if t.starts_with(full) || t.starts_with(&format!("{full}:")) || t.starts_with(&format!("{short}:")) || t.starts_with(&format!("{short} ")) {
            return Some((*short).to_string());
        }
    }
    None
}

fn first_number(line: &str) -> Option<f64> {
    let mut buf = String::new();
    let mut seen_digit = false;
    for ch in line.chars() {
        if ch.is_ascii_digit() || (ch == '.' && seen_digit && !buf.contains('.')) {
            buf.push(ch);
            seen_digit = true;
        } else if seen_digit {
            break;
        }
    }
    if buf.is_empty() {
        None
    } else {
        buf.parse().ok()
    }
}

pub fn parse_cal_file(path: &Path) -> Result<CalMetadata, String> {
    let content = fs::read_to_string(path).map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    parse_cal_contents(path, &content)
}

pub fn parse_cal_contents(path: &Path, content: &str) -> Result<CalMetadata, String> {
    let mut color_rep = None;
    let mut created = None;
    let mut description = None;
    let mut total_ink_limit = None;
    let mut format_fields: Vec<String> = Vec::new();
    let mut in_format = false;
    let mut in_data = false;
    let mut rows: Vec<Vec<f64>> = Vec::new();
    let mut ink_limits: Vec<ChannelLimit> = Vec::new();

    for raw in content.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.eq_ignore_ascii_case("BEGIN_DATA_FORMAT") {
            in_format = true;
            continue;
        }
        if line.eq_ignore_ascii_case("END_DATA_FORMAT") {
            in_format = false;
            continue;
        }
        if line.eq_ignore_ascii_case("BEGIN_DATA") {
            in_data = true;
            continue;
        }
        if line.eq_ignore_ascii_case("END_DATA") {
            in_data = false;
            continue;
        }
        if in_format {
            format_fields.extend(
                line.split_whitespace()
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty()),
            );
            continue;
        }
        if in_data {
            let nums: Vec<f64> = line
                .split_whitespace()
                .filter_map(|t| t.parse().ok())
                .collect();
            if !nums.is_empty() {
                rows.push(nums);
            }
            continue;
        }

        let (key, value) = split_cgats_kv(line);
        match key.to_ascii_uppercase().as_str() {
            "COLOR_REP" | "COLORANT_COLOURSPACE" => color_rep = Some(unquote(&value)),
            "CREATED" => created = Some(unquote(&value)),
            "DESCRIPTOR" | "DESCRIPTION" => description = Some(unquote(&value)),
            "MAX_TAC" | "TOTAL_INK_LIMIT" | "INK_LIMIT" => {
                total_ink_limit = unquote(&value).parse().ok();
            }
            other if other.starts_with("INK_LIMIT_") => {
                let ch = other.rsplit('_').next().unwrap_or("").to_string();
                if let Ok(percent) = unquote(&value).parse::<f64>() {
                    ink_limits.push(ChannelLimit { channel: ch, percent });
                }
            }
            _ => {}
        }
    }

    let curves = curves_from_rows(&format_fields, &rows);
    if ink_limits.is_empty() {
        ink_limits = infer_channel_limits_from_curves(&curves);
    }

    let modified_ms = fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(modified_ms);
    let age_days = if modified_ms == 0 {
        0.0
    } else {
        (now_ms.saturating_sub(modified_ms) as f64) / 86_400_000.0
    };

    Ok(CalMetadata {
        path: path.to_string_lossy().to_string(),
        filename: path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "unknown.cal".to_string()),
        color_rep,
        created,
        description,
        modified_ms,
        age_days,
        ink_limits,
        total_ink_limit,
        curves,
    })
}

fn split_cgats_kv(line: &str) -> (String, String) {
    let mut parts = line.splitn(2, char::is_whitespace);
    let key = parts.next().unwrap_or("").to_string();
    let value = parts.next().unwrap_or("").trim().to_string();
    (key, value)
}

fn unquote(s: &str) -> String {
    s.trim().trim_matches('"').to_string()
}

fn curves_from_rows(fields: &[String], rows: &[Vec<f64>]) -> Vec<CalCurve> {
    if fields.is_empty() || rows.is_empty() {
        return Vec::new();
    }
    let input_idx = fields.iter().position(|f| {
        let u = f.to_ascii_uppercase();
        u.ends_with("_I") || u == "RGB_I" || u == "CMYK_I" || u == "GRAY_I"
    });
    let Some(input_idx) = input_idx else {
        return Vec::new();
    };

    let mut curves = Vec::new();
    for (idx, field) in fields.iter().enumerate() {
        if idx == input_idx {
            continue;
        }
        let channel = channel_from_field(field);
        if channel.is_empty() {
            continue;
        }
        let mut points = Vec::new();
        for row in rows {
            if row.len() > input_idx && row.len() > idx {
                points.push([row[input_idx], row[idx]]);
            }
        }
        if !points.is_empty() {
            curves.push(CalCurve { channel, points });
        }
    }
    curves
}

fn channel_from_field(field: &str) -> String {
    let u = field.to_ascii_uppercase();
    if let Some(rest) = u.strip_prefix("RGB_") {
        return rest.to_string();
    }
    if let Some(rest) = u.strip_prefix("CMYK_") {
        return rest.to_string();
    }
    if u.contains("CYAN") || u.ends_with("_C") {
        return "C".to_string();
    }
    if u.contains("MAGENTA") || u.ends_with("_M") {
        return "M".to_string();
    }
    if u.contains("YELLOW") || u.ends_with("_Y") {
        return "Y".to_string();
    }
    if u.contains("BLACK") || u.ends_with("_K") {
        return "K".to_string();
    }
    field.to_string()
}

fn infer_channel_limits_from_curves(curves: &[CalCurve]) -> Vec<ChannelLimit> {
    curves
        .iter()
        .filter_map(|c| {
            let max_out = c.points.iter().map(|p| p[1]).fold(0.0_f64, f64::max);
            if max_out <= 0.0 {
                None
            } else {
                Some(ChannelLimit {
                    channel: c.channel.clone(),
                    percent: (max_out * 100.0).clamp(0.0, 100.0),
                })
            }
        })
        .collect()
}

pub fn is_cal_stale(age_days: f64, stale_days: u32) -> bool {
    age_days > f64::from(stale_days.max(1))
}

pub fn list_cal_files_in_dir(dir: &Path) -> Vec<CalMetadata> {
    let mut out = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let ext = path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if ext != "cal" {
            continue;
        }
        if let Ok(meta) = parse_cal_file(&path) {
            out.push(meta);
        }
    }
    out.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    out
}

pub fn project_state_path(cwd: &Path) -> PathBuf {
    cwd.join(PROJECT_STATE_FILENAME)
}

pub fn load_project_state(cwd: &Path) -> ProjectCalibrationState {
    let path = project_state_path(cwd);
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_project_state(cwd: &Path, state: &ProjectCalibrationState) -> Result<(), String> {
    fs::create_dir_all(cwd).map_err(|e| e.to_string())?;
    let path = project_state_path(cwd);
    let tmp = cwd.join(format!("{PROJECT_STATE_FILENAME}.tmp"));
    let json = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn library_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("calibrations");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[tauri::command]
pub async fn generate_calibration_target(
    app: AppHandle,
    state: State<'_, ProcessManager>,
    config: PrintcalTargetConfig,
) -> Result<String, String> {
    let basename = calibration_basename(&config.basename);
    let mut cfg = config;
    cfg.basename = basename.clone();
    let args = build_calibration_targen_args(&cfg)?;
    let binary = resolve_binary(app.clone(), "targen".to_string()).await?;
    let cwd = Some(resolve_safe_cwd(&app, &cfg.cwd)?);
    let id = format!("targen_{basename}");
    state.spawn(app, id, binary, args, cwd).await?;
    Ok(basename)
}

#[tauri::command]
pub async fn compute_calibration_curves(
    app: AppHandle,
    config: PrintcalConfig,
) -> Result<CalResult, String> {
    let cwd = resolve_safe_cwd(&app, &config.cwd)?;
    let basename = sanitize_cal_basename(&config.ti3_basename)?;
    let ti3 = Path::new(&cwd).join(format!("{basename}.ti3"));
    if !ti3.is_file() {
        return Err(format!(
            "Measurement file not found: {}. Measure the calibration chart before computing curves.",
            ti3.display()
        ));
    }

    let output_name = config
        .output_cal
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| {
            if s.to_ascii_lowercase().ends_with(".cal") {
                s.to_string()
            } else {
                format!("{s}.cal")
            }
        })
        .unwrap_or_else(|| format!("{basename}.cal"));
    if output_name.contains('/') || output_name.contains('\\') || output_name.contains("..") {
        return Err("output calibration filename is invalid".to_string());
    }
    let dest = Path::new(&cwd).join(&output_name);
    if dest.exists() && !config.force_overwrite {
        return Err(format!(
            "Calibration file already exists: {}. Choose Overwrite, Rename, or Cancel.",
            dest.display()
        ));
    }

    let mut run_cfg = config.clone();
    run_cfg.output_cal = Some(output_name.clone());
    let args = build_printcal_args(&run_cfg)?;
    let binary = resolve_binary(app.clone(), "printcal".to_string()).await?;
    let (code, stdout, stderr) = run_captured(&binary, &args, &cwd).await?;
    if code != 0 {
        return Err(format!(
            "printcal exited with code {code}. {}",
            stderr.lines().last().unwrap_or("No stderr.")
        ));
    }
    if !dest.is_file() {
        return Err(format!(
            "printcal reported success but {} was not created.",
            dest.display()
        ));
    }

    let (mut ink_limits, mut total, power) = parse_printcal_stdout(&stdout);
    let metadata = parse_cal_file(&dest).ok();
    if let Some(ref meta) = metadata {
        if ink_limits.is_empty() {
            ink_limits = meta.ink_limits.clone();
        }
        if total.is_none() {
            total = meta.total_ink_limit;
        }
    }

    log::info!(
        target: "calibration",
        "Computed calibration {} (limits: {:?}, TAC: {:?})",
        dest.display(),
        ink_limits,
        total
    );

    Ok(CalResult {
        cal_path: dest.to_string_lossy().to_string(),
        stdout,
        stderr,
        ink_limits,
        total_ink_limit: total,
        recommended_power: power,
        metadata,
        message: format!("Saved calibration curves to {}", dest.display()),
    })
}

#[tauri::command]
pub async fn apply_calibration(app: AppHandle, config: ApplycalConfig) -> Result<ApplycalResult, String> {
    let cal = PathBuf::from(config.cal_path.trim());
    if !cal.is_file() {
        return Err(format!("Calibration file not found: {}", cal.display()));
    }
    let input = PathBuf::from(config.input_path.trim());
    if !input.is_file() {
        return Err(format!("Input file not found: {}", input.display()));
    }

    let output = match config.output_path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(p) => PathBuf::from(p),
        None => input.clone(),
    };

    let tmp = if output == input {
        let mut t = input.clone();
        t.set_extension("applycal.tmp");
        t
    } else {
        output.clone()
    };

    let run_cfg = ApplycalConfig {
        cal_path: cal.to_string_lossy().to_string(),
        input_path: input.to_string_lossy().to_string(),
        output_path: Some(tmp.to_string_lossy().to_string()),
        unapply: config.unapply,
    };
    let args = build_applycal_args(&run_cfg)?;
    let binary = resolve_binary(app.clone(), "applycal".to_string()).await?;
    let cwd = input
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| ".".to_string());
    let (code, stdout, stderr) = run_captured(&binary, &args, &cwd).await?;
    if code != 0 {
        let _ = fs::remove_file(&tmp);
        return Err(format!(
            "applycal exited with code {code}. {}",
            stderr.lines().last().unwrap_or("No stderr.")
        ));
    }
    if tmp != output {
        fs::rename(&tmp, &output).map_err(|e| format!("Failed to replace profile with calibrated copy: {e}"))?;
    }
    log::info!(
        target: "calibration",
        "Applied {} to {} -> {}",
        cal.display(),
        input.display(),
        output.display()
    );
    Ok(ApplycalResult {
        output_path: output.to_string_lossy().to_string(),
        stdout,
        message: format!("Applied calibration to {}", output.display()),
    })
}

#[tauri::command]
pub fn parse_cal_file_cmd(path: String) -> Result<CalMetadata, String> {
    parse_cal_file(Path::new(&path))
}

#[tauri::command]
pub fn list_saved_calibrations(app: AppHandle, cwd: Option<String>) -> Result<Vec<CalMetadata>, String> {
    let mut all = Vec::new();
    if let Some(dir) = cwd {
        if !dir.trim().is_empty() {
            all.extend(list_cal_files_in_dir(Path::new(&dir)));
        }
    }
    if let Ok(lib) = library_dir(&app) {
        for meta in list_cal_files_in_dir(&lib) {
            if !all.iter().any(|m| m.path == meta.path) {
                all.push(meta);
            }
        }
    }
    all.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    Ok(all)
}

#[tauri::command]
pub fn save_calibration_to_library(app: AppHandle, cal_path: String) -> Result<String, String> {
    let src = Path::new(&cal_path);
    if !src.is_file() {
        return Err(format!("Calibration file not found: {cal_path}"));
    }
    let lib = library_dir(&app)?;
    let name = src
        .file_name()
        .ok_or_else(|| "invalid calibration filename".to_string())?;
    let dest = lib.join(name);
    fs::copy(src, &dest).map_err(|e| format!("Failed to copy into library: {e}"))?;
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn select_cal_file(
    app: AppHandle,
    default_dir: Option<String>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let mut builder = app
        .dialog()
        .file()
        .add_filter("Argyll calibration (*.cal)", &["cal"]);
    if let Some(ref dir) = default_dir {
        if !dir.trim().is_empty() {
            builder = builder.set_directory(PathBuf::from(dir));
        }
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    builder.pick_file(move |file_path| {
        let res = file_path.map(|p| p.to_string());
        let _ = tx.send(res);
    });
    rx.await.map_err(|e| format!("Dialog channel error: {e}"))
}

#[tauri::command]
pub fn load_project_calibration(cwd: String) -> Result<ProjectCalibrationState, String> {
    if cwd.trim().is_empty() {
        return Ok(ProjectCalibrationState::default());
    }
    Ok(load_project_state(Path::new(&cwd)))
}

#[tauri::command]
pub fn save_project_calibration(cwd: String, state: ProjectCalibrationState) -> Result<(), String> {
    if cwd.trim().is_empty() {
        return Err("working directory is empty".to_string());
    }
    save_project_state(Path::new(&cwd), &state)
}

async fn run_captured(binary: &str, args: &[String], cwd: &str) -> Result<(i32, String, String), String> {
    let mut cmd = tokio::process::Command::new(binary);
    cmd.args(args)
        .current_dir(cwd)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .env("ARGYLL_NOT_INTERACTIVE", "1");
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    log::info!(
        target: "subprocess",
        "Running captured {} {:?}",
        crate::process_manager::sanitize_arg_for_logging(binary),
        crate::process_manager::sanitize_args_for_logging(args)
    );
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to launch {binary}: {e}"))?;
    let code = output.status.code().unwrap_or(-1);
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    Ok((code, stdout, stderr))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rgb_target() -> PrintcalTargetConfig {
        PrintcalTargetConfig {
            colour_space: "rgb".to_string(),
            steps_per_channel: 21,
            ink_limit_exploration: Some(320),
            channels: None,
            white_patches: None,
            neutral_emphasis: false,
            basename: "photo".to_string(),
            cwd: "/tmp".to_string(),
        }
    }

    #[test]
    fn test_calibration_basename_prefix() {
        assert_eq!(calibration_basename("photo"), "CAL_photo");
        assert_eq!(calibration_basename("CAL_photo"), "CAL_photo");
        assert_eq!(calibration_basename("  "), "CAL_printer");
        assert!(is_calibration_basename("CAL_photo"));
        assert!(!is_calibration_basename("photo"));
    }

    #[test]
    fn test_clamp_steps() {
        assert_eq!(clamp_steps(5), 11);
        assert_eq!(clamp_steps(21), 21);
        assert_eq!(clamp_steps(99), 51);
    }

    #[test]
    fn test_build_calibration_targen_rgb() {
        let args = build_calibration_targen_args(&rgb_target()).unwrap();
        assert!(args.contains(&"-d".to_string()));
        assert!(args.contains(&"2".to_string()));
        assert!(args.contains(&"-s".to_string()));
        assert!(args.contains(&"21".to_string()));
        assert!(args.contains(&"-g".to_string()));
        assert!(args.contains(&"-f".to_string()));
        assert!(args.contains(&"0".to_string()));
        assert_eq!(args.last().unwrap(), "photo");
        assert!(!args.contains(&"-l".to_string()), "RGB must not pass -l");
    }

    #[test]
    fn test_build_calibration_targen_cmyk_ink_limit() {
        let mut cfg = rgb_target();
        cfg.colour_space = "cmyk".to_string();
        cfg.basename = "CAL_press".to_string();
        cfg.neutral_emphasis = true;
        let args = build_calibration_targen_args(&cfg).unwrap();
        assert!(args.contains(&"4".to_string()));
        assert!(args.contains(&"-l".to_string()));
        assert!(args.contains(&"320".to_string()));
        assert!(args.contains(&"-n".to_string()));
        assert_eq!(args.last().unwrap(), "CAL_press");
    }

    #[test]
    fn test_build_calibration_targen_rejects_path() {
        let mut cfg = rgb_target();
        cfg.basename = "../escape".to_string();
        assert!(build_calibration_targen_args(&cfg).is_err());
    }

    #[test]
    fn test_build_printcal_args_defaults() {
        let cfg = PrintcalConfig {
            ti3_basename: "CAL_photo".to_string(),
            cwd: "/tmp".to_string(),
            output_cal: None,
            previous_cal: None,
            force_overwrite: false,
            no_ink_limit: false,
            verify: false,
            total_ink_limit: None,
            channel_limits: vec![],
        };
        let args = build_printcal_args(&cfg).unwrap();
        assert_eq!(
            args,
            vec!["-v", "-e", "-o", "CAL_photo.cal", "CAL_photo"]
        );
    }

    #[test]
    fn test_build_printcal_args_overrides_and_prev() {
        let cfg = PrintcalConfig {
            ti3_basename: "CAL_press".to_string(),
            cwd: "/tmp".to_string(),
            output_cal: Some("press_lin.cal".to_string()),
            previous_cal: Some("old.cal".to_string()),
            force_overwrite: true,
            no_ink_limit: true,
            verify: true,
            total_ink_limit: Some(280.0),
            channel_limits: vec![ChannelLimit {
                channel: "C".to_string(),
                percent: 95.0,
            }],
        };
        let args = build_printcal_args(&cfg).unwrap();
        assert!(args.contains(&"-I".to_string()));
        assert!(args.contains(&"-z".to_string()));
        assert!(args.contains(&"-a".to_string()));
        assert!(args.contains(&"old.cal".to_string()));
        assert!(args.contains(&"-m".to_string()));
        assert!(args.contains(&"280.0".to_string()));
        assert!(args.contains(&"-xC".to_string()));
        assert!(args.contains(&"95.0".to_string()));
        assert!(args.contains(&"press_lin.cal".to_string()));
    }

    #[test]
    fn test_build_applycal_args() {
        let cfg = ApplycalConfig {
            cal_path: "lin.cal".to_string(),
            input_path: "out.icc".to_string(),
            output_path: Some("out_cal.icc".to_string()),
            unapply: false,
        };
        let args = build_applycal_args(&cfg).unwrap();
        assert_eq!(args, vec!["-v", "-a", "lin.cal", "out.icc", "out_cal.icc"]);
    }

    #[test]
    fn test_build_applycal_unapply_and_empty() {
        let cfg = ApplycalConfig {
            cal_path: "".to_string(),
            input_path: "out.icc".to_string(),
            output_path: None,
            unapply: true,
        };
        assert!(build_applycal_args(&cfg).is_err());
        let cfg = ApplycalConfig {
            cal_path: "lin.cal".to_string(),
            input_path: "out.icc".to_string(),
            output_path: None,
            unapply: true,
        };
        let args = build_applycal_args(&cfg).unwrap();
        assert_eq!(args, vec!["-v", "-u", "lin.cal", "out.icc"]);
    }

    #[test]
    fn test_parse_printcal_stdout_limits() {
        let stdout = r#"
printcal: Creating calibration
Ideal power value to apply to the test chart = 1.35
Ink limits:
  Cyan: 96.4%
  Magenta: 94.1%
  Yellow: 98.0%
  Black: 90.2%
  Total ink limit: 280.0%
"#;
        let (limits, total, power) = parse_printcal_stdout(stdout);
        assert_eq!(power, Some(1.35));
        assert_eq!(total, Some(280.0));
        assert_eq!(limits.len(), 4);
        assert_eq!(limits[0].channel, "C");
        assert!((limits[0].percent - 96.4).abs() < 0.01);
    }

    #[test]
    fn test_parse_cal_contents_cmyk_curves() {
        let cal = r#"
CAL
DESCRIPTOR "Argyll Device Calibration File"
CREATED "Mon Sep  7 17:00:00 2026"
KEYWORD "COLOR_REP"
COLOR_REP "CMYK"
KEYWORD "MAX_TAC"
MAX_TAC "280.000000"
KEYWORD "NUMBER_OF_FIELDS"
NUMBER_OF_FIELDS 5
BEGIN_DATA_FORMAT
CMYK_I CMYK_C CMYK_M CMYK_Y CMYK_K
END_DATA_FORMAT
NUMBER_OF_SETS 3
BEGIN_DATA
0.0 0.00 0.00 0.00 0.00
0.5 0.42 0.40 0.45 0.38
1.0 0.95 0.92 0.98 0.90
END_DATA
"#;
        let meta = parse_cal_contents(Path::new("/tmp/demo.cal"), cal).unwrap();
        assert_eq!(meta.color_rep.as_deref(), Some("CMYK"));
        assert_eq!(meta.total_ink_limit, Some(280.0));
        assert_eq!(meta.curves.len(), 4);
        assert_eq!(meta.curves[0].channel, "C");
        assert_eq!(meta.curves[0].points.len(), 3);
        assert!((meta.ink_limits.iter().find(|l| l.channel == "C").unwrap().percent - 95.0).abs() < 0.01);
    }

    #[test]
    fn test_is_cal_stale() {
        assert!(!is_cal_stale(10.0, 30));
        assert!(!is_cal_stale(30.0, 30));
        assert!(is_cal_stale(31.0, 30));
    }

    #[test]
    fn test_missing_measurement_error_path_message() {
        // The command itself needs a Tauri app; the path construction is covered
        // by sanitize + ti3 join used in compute_calibration_curves.
        let basename = sanitize_cal_basename("CAL_x").unwrap();
        let ti3 = Path::new("/tmp").join(format!("{basename}.ti3"));
        assert_eq!(ti3, Path::new("/tmp/CAL_x.ti3"));
    }
}
