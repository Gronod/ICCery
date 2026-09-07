//! System-wide ICC/ICM profile installation (#223).
//!
//! Copies a generated profile into the OS colour-management directory and,
//! where available, registers it (Windows ICM, macOS ColorSync, Linux colord).
//! The working-directory artefact is never moved.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

const MIN_PROFILE_BYTES: u64 = 128;

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct InstallOptions {
    #[serde(default)]
    pub force_overwrite: bool,
    #[serde(default)]
    pub prefer_system_wide: bool,
    #[serde(default = "default_true")]
    pub register_with_os: bool,
    /// `overwrite` | `rename` | `cancel` — used when the destination exists.
    #[serde(default = "default_collision")]
    pub collision_policy: String,
    #[serde(default)]
    pub open_color_panel: bool,
    #[serde(default)]
    pub calibration_note: Option<String>,
}

fn default_true() -> bool {
    true
}
fn default_collision() -> String {
    "cancel".to_string()
}

impl Default for InstallOptions {
    fn default() -> Self {
        Self {
            force_overwrite: false,
            prefer_system_wide: false,
            register_with_os: true,
            collision_policy: default_collision(),
            open_color_panel: false,
            calibration_note: None,
        }
    }
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq)]
pub struct InstallResult {
    pub dest_path: String,
    pub registered: bool,
    pub overwritten: bool,
    pub renamed: bool,
    pub opened_panel: bool,
    pub message: String,
    pub calibration_note: Option<String>,
}

#[derive(Debug, Clone)]
pub struct InstallEnv {
    pub os: String,
    pub home: Option<PathBuf>,
    pub windir: Option<PathBuf>,
}

impl InstallEnv {
    pub fn from_process() -> Self {
        Self {
            os: std::env::consts::OS.to_string(),
            home: std::env::var_os("HOME")
                .or_else(|| std::env::var_os("USERPROFILE"))
                .map(PathBuf::from),
            windir: std::env::var_os("WINDIR")
                .or_else(|| std::env::var_os("SystemRoot"))
                .map(PathBuf::from),
        }
    }
}

pub fn profile_extension_for_os(os: &str) -> &'static str {
    if os.eq_ignore_ascii_case("windows") {
        "icm"
    } else {
        "icc"
    }
}

pub fn user_profile_dir(env: &InstallEnv) -> Result<PathBuf, String> {
    match env.os.as_str() {
        "windows" => {
            let home = env.home.clone().ok_or_else(|| {
                "USERPROFILE is not set; cannot resolve the per-user Color directory.".to_string()
            })?;
            Ok(home.join("AppData").join("Local").join("Microsoft").join("Windows").join("Color"))
        }
        "macos" => {
            let home = env.home.clone().ok_or_else(|| {
                "HOME is not set; cannot resolve ~/Library/ColorSync/Profiles.".to_string()
            })?;
            Ok(home.join("Library").join("ColorSync").join("Profiles"))
        }
        _ => {
            let home = env.home.clone().ok_or_else(|| {
                "HOME is not set; cannot resolve ~/.local/share/icc.".to_string()
            })?;
            Ok(home.join(".local").join("share").join("icc"))
        }
    }
}

pub fn system_profile_dir(env: &InstallEnv) -> Result<PathBuf, String> {
    match env.os.as_str() {
        "windows" => {
            let windir = env.windir.clone().ok_or_else(|| {
                "WINDIR is not set; cannot resolve %WINDIR%\\System32\\spool\\drivers\\color.".to_string()
            })?;
            Ok(windir.join("System32").join("spool").join("drivers").join("color"))
        }
        "macos" => Ok(PathBuf::from("/Library/ColorSync/Profiles")),
        _ => Ok(PathBuf::from("/usr/share/color/icc")),
    }
}

pub fn target_profile_dir(env: &InstallEnv, prefer_system_wide: bool) -> Result<PathBuf, String> {
    if prefer_system_wide {
        system_profile_dir(env)
    } else {
        user_profile_dir(env)
    }
}

pub fn dest_filename(source: &Path, os: &str) -> Result<String, String> {
    let stem = source
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "profile filename is invalid".to_string())?;
    if stem.contains("..") || stem.contains('/') || stem.contains('\\') {
        return Err("profile filename is invalid".to_string());
    }
    Ok(format!("{stem}.{}", profile_extension_for_os(os)))
}

pub fn timestamped_filename(name: &str) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) => (s, e),
        None => (name, "icc"),
    };
    format!("{stem}-{now}.{ext}")
}

pub fn verify_source_profile(path: &Path) -> Result<u64, String> {
    if !path.is_file() {
        return Err(format!("Profile artefact not found: {}", path.display()));
    }
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ext != "icc" && ext != "icm" {
        return Err("Source file must be an .icc or .icm profile.".to_string());
    }
    let len = fs::metadata(path)
        .map_err(|e| format!("Cannot stat profile: {e}"))?
        .len();
    if len < MIN_PROFILE_BYTES {
        return Err(format!(
            "Profile is too small ({len} bytes) to be a valid ICC header."
        ));
    }
    Ok(len)
}

pub fn resolve_destination(
    dest_dir: &Path,
    filename: &str,
    options: &InstallOptions,
) -> Result<(PathBuf, bool, bool), String> {
    let dest = dest_dir.join(filename);
    if !dest.exists() {
        return Ok((dest, false, false));
    }
    let policy = options.collision_policy.to_ascii_lowercase();
    if options.force_overwrite || policy == "overwrite" {
        return Ok((dest, true, false));
    }
    if policy == "rename" {
        return Ok((dest_dir.join(timestamped_filename(filename)), false, true));
    }
    Err(format!(
        "A profile named {filename} already exists at {}. Choose Overwrite, Rename, or Cancel.",
        dest.display()
    ))
}

fn copy_atomic(src: &Path, dest: &Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            permission_message(parent, &e)
        })?;
    }
    let tmp = dest.with_extension("iccery-install.tmp");
    fs::copy(src, &tmp).map_err(|e| permission_message(&tmp, &e))?;
    fs::rename(&tmp, dest).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        permission_message(dest, &e)
    })?;
    Ok(())
}

fn permission_message(path: &Path, err: &std::io::Error) -> String {
    if err.kind() == std::io::ErrorKind::PermissionDenied {
        #[cfg(target_os = "windows")]
        {
            return format!(
                "Access denied writing {}. On Windows the system Color folder usually requires 'Run as Administrator'. Retry with elevation, or install to the per-user Color directory instead.",
                path.display()
            );
        }
        #[cfg(target_os = "macos")]
        {
            return format!(
                "Permission denied writing {}. Install to ~/Library/ColorSync/Profiles (no elevation) or authenticate to write /Library/ColorSync/Profiles.",
                path.display()
            );
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            return format!(
                "Permission denied writing {}. Install to ~/.local/share/icc (no root) or use pkexec/sudo for /usr/share/color/icc.",
                path.display()
            );
        }
    }
    format!("Failed to write {}: {err}", path.display())
}

fn register_profile(dest: &Path, os: &str) -> bool {
    match os {
        "windows" => register_windows(dest),
        "macos" => true, // ColorSync discovers files in the Profiles folders.
        _ => register_colord(dest),
    }
}

fn register_windows(dest: &Path) -> bool {
    // Copy into the Color directory is sufficient for most apps. Try the
    // classic InstallColorProfile helper when present; ignore failure.
    let _ = Command::new("rundll32")
        .args([
            "mscms.dll,InstallColorProfileW",
            &dest.to_string_lossy(),
        ])
        .status();
    true
}

fn register_colord(dest: &Path) -> bool {
    match Command::new("colormgr")
        .args(["import-profile", &dest.to_string_lossy()])
        .output()
    {
        Ok(out) if out.status.success() => true,
        _ => false,
    }
}

fn open_color_panel(os: &str) -> bool {
    let result = match os {
        "windows" => Command::new("colorcpl").status(),
        "macos" => Command::new("open").args(["-a", "ColorSync Utility"]).status(),
        _ => Command::new("colormgr")
            .arg("get-profiles")
            .status()
            .or_else(|_| Command::new("gnome-control-center").arg("color").status()),
    };
    result.map(|s| s.success()).unwrap_or(false)
}

pub fn install_profile_with_env(
    profile_path: &str,
    options: &InstallOptions,
    env: &InstallEnv,
) -> Result<InstallResult, String> {
    let src = PathBuf::from(profile_path.trim());
    let src_size = verify_source_profile(&src)?;
    let dir = target_profile_dir(env, options.prefer_system_wide)?;
    let filename = dest_filename(&src, &env.os)?;
    let (dest, overwritten, renamed) = resolve_destination(&dir, &filename, options)?;

    copy_atomic(&src, &dest)?;

    let dest_size = fs::metadata(&dest)
        .map_err(|e| format!("Installed file missing after copy: {e}"))?
        .len();
    if dest_size != src_size {
        return Err("Installed profile size does not match the working-directory artefact.".to_string());
    }

    let registered = if options.register_with_os {
        register_profile(&dest, &env.os)
    } else {
        false
    };
    let opened = if options.open_color_panel {
        open_color_panel(&env.os)
    } else {
        false
    };

    let mut message = format!("Installed profile to {}", dest.display());
    if overwritten {
        message.push_str(" (replaced existing file)");
    } else if renamed {
        message.push_str(" (renamed to avoid collision)");
    }
    if let Some(ref note) = options.calibration_note {
        if !note.trim().is_empty() {
            message.push_str(". ");
            message.push_str(note.trim());
        }
    }

    log::info!(target: "profile_install", "{message}");

    Ok(InstallResult {
        dest_path: dest.to_string_lossy().to_string(),
        registered,
        overwritten,
        renamed,
        opened_panel: opened,
        message,
        calibration_note: options.calibration_note.clone(),
    })
}

#[tauri::command]
pub fn get_profile_install_dir(prefer_system_wide: Option<bool>) -> Result<String, String> {
    let env = InstallEnv::from_process();
    let dir = target_profile_dir(&env, prefer_system_wide.unwrap_or(false))?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn install_profile_to_system(
    _app: AppHandle,
    profile_path: String,
    options: Option<InstallOptions>,
) -> Result<InstallResult, String> {
    let options = options.unwrap_or_default();
    install_profile_with_env(&profile_path, &options, &InstallEnv::from_process())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_linux() -> InstallEnv {
        InstallEnv {
            os: "linux".to_string(),
            home: Some(PathBuf::from("/home/gordon")),
            windir: None,
        }
    }
    fn env_mac() -> InstallEnv {
        InstallEnv {
            os: "macos".to_string(),
            home: Some(PathBuf::from("/Users/gordon")),
            windir: None,
        }
    }
    fn env_win() -> InstallEnv {
        InstallEnv {
            os: "windows".to_string(),
            home: Some(PathBuf::from(r"C:\Users\gordon")),
            windir: Some(PathBuf::from(r"C:\Windows")),
        }
    }

    #[test]
    fn test_user_and_system_dirs_linux() {
        let env = env_linux();
        assert_eq!(
            user_profile_dir(&env).unwrap(),
            PathBuf::from("/home/gordon/.local/share/icc")
        );
        assert_eq!(
            system_profile_dir(&env).unwrap(),
            PathBuf::from("/usr/share/color/icc")
        );
        assert_eq!(
            target_profile_dir(&env, false).unwrap(),
            user_profile_dir(&env).unwrap()
        );
        assert_eq!(
            target_profile_dir(&env, true).unwrap(),
            system_profile_dir(&env).unwrap()
        );
    }

    #[test]
    fn test_user_and_system_dirs_macos() {
        let env = env_mac();
        assert_eq!(
            user_profile_dir(&env).unwrap(),
            PathBuf::from("/Users/gordon/Library/ColorSync/Profiles")
        );
        assert_eq!(
            system_profile_dir(&env).unwrap(),
            PathBuf::from("/Library/ColorSync/Profiles")
        );
        assert_eq!(profile_extension_for_os("macos"), "icc");
    }

    #[test]
    fn test_windows_system_color_dir_and_icm() {
        let env = env_win();
        assert_eq!(
            system_profile_dir(&env).unwrap(),
            PathBuf::from(r"C:\Windows\System32\spool\drivers\color")
        );
        assert_eq!(profile_extension_for_os("windows"), "icm");
        let dest = dest_filename(Path::new(r"C:\work\Press.icc"), "windows").unwrap();
        assert_eq!(dest, "Press.icm");
    }

    #[test]
    fn test_dest_filename_unix_keeps_icc() {
        let name = dest_filename(Path::new("/tmp/photo.icm"), "linux").unwrap();
        assert_eq!(name, "photo.icc");
    }

    #[test]
    fn test_dest_filename_rejects_invalid() {
        assert!(dest_filename(Path::new(""), "linux").is_err());
        assert!(dest_filename(Path::new(".."), "linux").is_err());
    }

    #[test]
    fn test_resolve_destination_cancel() {
        let dir = std::env::temp_dir();
        let existing = dir.join("iccery-install-collision.icc");
        fs::write(&existing, vec![0u8; 200]).unwrap();
        let opts = InstallOptions {
            collision_policy: "cancel".to_string(),
            ..Default::default()
        };
        let err = resolve_destination(&dir, "iccery-install-collision.icc", &opts).unwrap_err();
        assert!(err.contains("already exists"));
        let _ = fs::remove_file(existing);
    }

    #[test]
    fn test_resolve_destination_rename_and_overwrite() {
        let dir = std::env::temp_dir();
        let filename = "iccery-install-exists.icc";
        let existing = dir.join(filename);
        fs::write(&existing, vec![0u8; 200]).unwrap();
        let rename = InstallOptions {
            collision_policy: "rename".to_string(),
            ..Default::default()
        };
        let (path, overwritten, renamed) = resolve_destination(&dir, filename, &rename).unwrap();
        assert!(!overwritten && renamed);
        assert_ne!(path, existing);
        let over = InstallOptions {
            collision_policy: "overwrite".to_string(),
            ..Default::default()
        };
        let (path2, overwritten2, renamed2) = resolve_destination(&dir, filename, &over).unwrap();
        assert!(overwritten2 && !renamed2);
        assert_eq!(path2, existing);
        let _ = fs::remove_file(existing);
    }

    #[test]
    fn test_verify_source_profile_rejects_missing_and_tiny() {
        let missing = PathBuf::from("/tmp/does-not-exist-iccery.icc");
        assert!(verify_source_profile(&missing).is_err());
        let tiny = std::env::temp_dir().join("iccery-tiny.icc");
        fs::write(&tiny, b"short").unwrap();
        assert!(verify_source_profile(&tiny).is_err());
        let _ = fs::remove_file(tiny);
    }

    #[test]
    fn test_timestamped_filename_preserves_extension() {
        let name = timestamped_filename("Press.icm");
        assert!(name.starts_with("Press-"));
        assert!(name.ends_with(".icm"));
    }

    #[test]
    fn test_install_profile_copy_roundtrip() {
        let tmp = std::env::temp_dir().join(format!(
            "iccery-install-{}",
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()
        ));
        fs::create_dir_all(&tmp).unwrap();
        let src = tmp.join("demo.icc");
        let bytes = vec![0u8; 256];
        fs::write(&src, &bytes).unwrap();
        let env = InstallEnv {
            os: "linux".to_string(),
            home: Some(tmp.join("home")),
            windir: None,
        };
        let result = install_profile_with_env(
            &src.to_string_lossy(),
            &InstallOptions {
                register_with_os: false,
                open_color_panel: false,
                calibration_note: Some("Curves from CAL_demo.cal were applied.".to_string()),
                ..Default::default()
            },
            &env,
        )
        .unwrap();
        assert!(Path::new(&result.dest_path).is_file());
        assert!(src.is_file(), "source artefact must remain");
        assert!(result.message.contains("Curves from CAL_demo.cal"));
        let _ = fs::remove_dir_all(tmp);
    }
}
