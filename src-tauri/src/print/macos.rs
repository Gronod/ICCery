#![allow(dead_code)]

use std::path::Path;
use crate::print::PrintOptions;
pub use crate::print::unix::{
    get_printer_capabilities, get_printers,
};

/// Construct `lp` command line arguments for target printing on macOS with ColorSync bypass flags.
pub fn build_lp_args(
    printer_name: &str,
    tiff_path: &str,
    options: Option<&PrintOptions>,
) -> Vec<String> {
    let path = Path::new(tiff_path);
    let title = format!(
        "ICCery Target - {}",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("Profiling Target")
    );

    let mut args = vec![
        "-d".to_string(),
        printer_name.to_string(),
        "-t".to_string(),
        title,
    ];

    let ppd_fallback = options
        .and_then(|o| o.ppd_uncorrected_passthrough)
        .unwrap_or(false);

    // Always apply ColorSync bypass on macOS for targeting
    args.push("-o".to_string());
    args.push("AP_ColorMatchingMode=AP_ApplicationColorMatching".to_string());

    // Fetch lpoptions for this printer to detect capabilities
    if let Ok(out) = std::process::Command::new("lpoptions")
        .args(["-p", printer_name, "-l"])
        .output()
    {
        if out.status.success() {
            let output_str = String::from_utf8_lossy(&out.stdout);

            if let Some(opts) = options {
                if let Some(ref media_type) = opts.media_type {
                    if !media_type.trim().is_empty() {
                        let key = crate::print::unix::detect_media_type_key(&output_str);
                        args.push("-o".to_string());
                        args.push(format!("{}={}", key, media_type.trim()));
                    }
                }
            }

            if ppd_fallback {
                if let Some((bypass_key, bypass_val)) =
                    crate::print::unix::detect_driver_color_bypass(&output_str)
                {
                    args.push("-o".to_string());
                    args.push(format!("{}={}", bypass_key, bypass_val));
                }
            }
        }
    }

    if let Some(opts) = options {
        if let Some(ref orient) = opts.orientation {
            args.push("-o".to_string());
            if orient.eq_ignore_ascii_case("landscape") {
                args.push("orientation-requested=4".to_string());
            } else {
                args.push("orientation-requested=3".to_string());
            }
        }

        if let Some(ref page_size) = opts.paper_size {
            if !page_size.trim().is_empty() {
                args.push("-o".to_string());
                args.push(format!("PageSize={}", page_size.trim()));
            }
        }
    }

    args.push(tiff_path.to_string());
    args
}

/// Spool target TIFF to macOS CUPS printer bypassing ColorSync and PPD color management.
pub fn print_target(
    printer_name: &str,
    tiff_path: &str,
    options: Option<&PrintOptions>,
) -> Result<(), String> {
    let path = Path::new(tiff_path);
    if !path.exists() {
        return Err(format!("Target TIFF file not found: {}", tiff_path));
    }

    let args = build_lp_args(printer_name, tiff_path, options);

    let output = std::process::Command::new("lp")
        .args(&args)
        .output()
        .map_err(|e| format!("Failed to execute 'lp' command: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let msg = if !stderr.trim().is_empty() {
            stderr.trim().to_string()
        } else if !stdout.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            format!("exited with status code {}", output.status.code().unwrap_or(-1))
        };
        return Err(format!("macOS CUPS print job failed: {}", msg));
    }

    Ok(())
}

/// Open macOS printer queue / properties management or inspect queue options.
pub fn show_printer_properties(printer_name: &str) -> Result<(), String> {
    // macOS System Preferences don't show PPD driver options.
    // We open the CUPS web interface instead.
    let url = format!("http://localhost:631/printers/{}", printer_name);
    let _ = std::process::Command::new("open")
        .args([&url])
        .spawn();

    Ok(())
}
