#![allow(dead_code)]

use std::ffi::CStr;
use std::path::Path;
use std::ptr::NonNull;

use crate::print::PrintOptions;
pub use crate::print::unix::{get_printer_capabilities, get_printers};

extern "C" {
    fn free(ptr: *mut std::ffi::c_void);
}

/// PPD/driver-relevant CUPS option key names that we forward to `lp` when
/// captured from the native print panel. Keys not in this set (internal Apple
/// ticket keys, generic CUPS bookkeeping, etc.) are discarded.
const RELEVANT_CUPS_OPTION_KEYS: &[&str] = &[
    // Media type
    "MediaType",
    "CNIJMediaType",
    "EPIJ_Medi",
    "StpMediaType",
    // Input slot / tray
    "InputSlot",
    "AP_D_InputSlot",
    // Paper size
    "PageSize",
    // Driver color management bypass
    "CNIJIntent2",
    "CNIJIntent",
    "EPIJ_CCor",
    "EPIJ_OSColMat",
    "ColorCorrection",
    "StpColorCorrection",
    "EpsonColorMode",
    "ColorModel",
    // Quality / resolution
    "Resolution",
    "cupsPrintQuality",
    "Quality",
    "EPIJ_Quality",
    "CNIJQuality",
    "StpQuality",
    "OutputMode",
    // Duplex
    "Duplex",
    "sides",
];

/// Return true if a CUPS option key/value pair captured from the native print
/// panel should be forwarded to the `lp` command.
fn is_relevant_cups_option(key: &str, value: &str) -> bool {
    if key.is_empty() {
        return false;
    }
    // Never forward internal Apple ticket keys.
    if key.starts_with("com.apple.") {
        return false;
    }
    // We always set AP_ColorMatchingMode ourselves in build_lp_args.
    if key == "AP_ColorMatchingMode" {
        return false;
    }
    // Skip empty values (e.g. "AP_D_InputSlot=").
    if value.is_empty() {
        return false;
    }
    // Skip generic CUPS bookkeeping keys that don't affect color or quality.
    if matches!(
        key,
        "collate" | "copies" | "pserrorhandler-requested" | "job-sheets"
    ) {
        return false;
    }
    // Keep known PPD option keys, or any other non-Apple key that looks
    // driver-specific (permissive: unknown driver keys are kept).
    RELEVANT_CUPS_OPTION_KEYS.contains(&key) || !key.starts_with("com.")
}

/// Filter a raw CUPS options string (as produced by PMPrintSettingsToOptions)
/// down to only the PPD-relevant pairs, returning them as a space-separated
/// `"key=value key=value"` string.
fn filter_cups_options_string(raw: &str) -> Option<String> {
    let pairs = crate::print::unix::parse_cups_options_string(raw);
    let filtered: Vec<(String, String)> = pairs
        .into_iter()
        .filter(|(k, v)| is_relevant_cups_option(k, v))
        .collect();
    if filtered.is_empty() {
        None
    } else {
        Some(
            filtered
                .iter()
                .map(|(k, v)| format!("{}={}", k, v))
                .collect::<Vec<_>>()
                .join(" "),
        )
    }
}

/// Extract the media type value from a filtered CUPS options string, looking
/// for the first known media-type key.
fn extract_media_type_from_options(options: &str) -> Option<String> {
    let pairs = crate::print::unix::parse_cups_options_string(options);
    for (key, value) in &pairs {
        if matches!(
            key.as_str(),
            "MediaType" | "CNIJMediaType" | "EPIJ_Medi" | "StpMediaType"
        ) {
            if !value.is_empty() {
                return Some(value.clone());
            }
        }
    }
    None
}

/// Show the native macOS `NSPrintPanel` for the selected printer, pre-configured
/// with application-managed color so the driver's color-management controls are
/// greyed out. Returns the user's captured print settings as a `PrintOptions`
/// snapshot.
///
/// This function must be called on the Cocoa main thread. The caller is
/// responsible for dispatching via `AppHandle::run_on_main_thread`.
fn run_native_print_panel(printer_name: &str) -> Result<PrintOptions, String> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSPrintInfo, NSPrintPanel, NSPrintPanelOptions, NSPrinter};
    use objc2_application_services::{
        PMCopyPrintSettings, PMCreatePrintSettings, PMRelease, PMPrintSettings,
        PMPrintSettingsToOptions, PMPrintSettingsSetValue,
    };
    use objc2_core_foundation::CFString;
    use objc2_foundation::NSString;

    let mtm = MainThreadMarker::new()
        .ok_or("Print panel must be invoked on the main thread")?;

    // Look up the NSPrinter by name.
    let name_ns = NSString::from_str(printer_name);
    let printer = NSPrinter::printerWithName(&name_ns)
        .ok_or_else(|| format!("No NSPrinter found for '{}'", printer_name))?;

    // Create a fresh NSPrintInfo and configure it for the selected printer.
    let print_info = NSPrintInfo::new();
    print_info.setPrinter(&printer);
    print_info.setUpPrintOperationDefaultValues();

    // Set AP_ColorMatchingMode = AP_ApplicationColorMatching on the
    // underlying PMPrintSettings so the driver's ColorSync / vendor color
    // management controls are greyed out in the panel.
    let pm_settings_raw: PMPrintSettings = print_info.PMPrintSettings().as_ptr() as PMPrintSettings;
    let cm_key = CFString::from_str("AP_ColorMatchingMode");
    let cm_val = CFString::from_str("AP_ApplicationColorMatching");
    let set_status = unsafe {
        PMPrintSettingsSetValue(pm_settings_raw, &cm_key, Some(cm_val.as_ref()), false)
    };
    if set_status != 0 {
        log::warn!(
            "PMPrintSettingsSetValue(AP_ColorMatchingMode) returned status {}",
            set_status
        );
    }
    // Sync the PMPrintSettings changes back into the NSPrintInfo object.
    print_info.updateFromPMPrintSettings();

    // Create and configure the print panel.
    let panel = NSPrintPanel::printPanel(mtm);
    let mut opts = NSPrintPanelOptions::all();
    opts.insert(NSPrintPanelOptions::ShowsPageSetupAccessory);
    panel.setOptions(opts);
    panel.setDefaultButtonTitle(Some(&NSString::from_str("Use Settings")));

    // Run the modal dialog.
    let response = panel.runModalWithPrintInfo(&print_info);

    // NSModalResponseOK == NSOKButton == 1.
    if response != 1 {
        return Err("Printer properties dialog was cancelled".to_string());
    }

    // Extract the updated print info from the panel.
    let updated_info = panel.printInfo();
    let updated_settings_raw: PMPrintSettings =
        updated_info.PMPrintSettings().as_ptr() as PMPrintSettings;

    // PMPrintSettingsToOptions may crash when AP_ColorMatchingMode is present
    // in the settings. To avoid this, copy the settings into a fresh
    // PMPrintSettings object and then call PMPrintSettingsToOptions on the
    // copy. The copy will still contain AP_ColorMatchingMode, but we filter
    // it out of the resulting string.
    let mut copy_settings: PMPrintSettings = std::ptr::null_mut();
    let copy_status = unsafe {
        PMCreatePrintSettings(NonNull::new(&mut copy_settings).unwrap())
    };
    if copy_status != 0 {
        return Err(format!(
            "PMCreatePrintSettings failed with status {}",
            copy_status
        ));
    }
    let copy_result = unsafe { PMCopyPrintSettings(updated_settings_raw, copy_settings) };
    if copy_result != 0 {
        unsafe { PMRelease(copy_settings as _) };
        return Err(format!(
            "PMCopyPrintSettings failed with status {}",
            copy_result
        ));
    }

    let mut opts_ptr: *mut std::ffi::c_char = std::ptr::null_mut();
    let to_opts_status = unsafe {
        PMPrintSettingsToOptions(
            copy_settings,
            NonNull::new(&mut opts_ptr).unwrap(),
        )
    };
    unsafe { PMRelease(copy_settings as _) };

    if to_opts_status != 0 || opts_ptr.is_null() {
        return Err(format!(
            "PMPrintSettingsToOptions failed with status {}",
            to_opts_status
        ));
    }

    let opts_cstr = unsafe { CStr::from_ptr(opts_ptr) };
    let opts_str = opts_cstr.to_string_lossy().into_owned();
    unsafe { free(opts_ptr as *mut _) };

    // Filter to PPD-relevant options.
    let cups_options = filter_cups_options_string(&opts_str);

    // Try to extract a media type from the captured options.
    let media_type = cups_options
        .as_ref()
        .and_then(|s| extract_media_type_from_options(s));

    Ok(PrintOptions {
        media_type,
        cups_options,
        ppd_uncorrected_passthrough: Some(true),
        ..Default::default()
    })
}

/// Construct `lp` command line arguments for target printing on macOS with
/// ColorSync bypass flags and any user-captured PPD options.
pub fn build_lp_args(
    printer_name: &str,
    tiff_path: &str,
    options: Option<&PrintOptions>,
) -> Vec<String> {
    let path = Path::new(tiff_path);
    let title = format!(
        "ICCery Target - {}",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("Profiling Target")
    );

    let mut args = vec![
        "-d".to_string(),
        printer_name.to_string(),
        "-t".to_string(),
        title,
    ];

    // Always apply ColorSync bypass on macOS for targeting.
    args.push("-o".to_string());
    args.push("AP_ColorMatchingMode=AP_ApplicationColorMatching".to_string());

    // Track which option keys have already been added from cups_options so we
    // don't duplicate them from the explicit PrintOptions fields.
    let mut added_keys: std::collections::HashSet<String> = std::collections::HashSet::new();

    // If we have captured CUPS options from the native print panel, add them
    // first. These take precedence over auto-detected defaults.
    if let Some(opts) = options {
        if let Some(ref cups_opts) = opts.cups_options {
            if !cups_opts.trim().is_empty() {
                for (key, value) in crate::print::unix::parse_cups_options_string(cups_opts) {
                    if !key.is_empty() {
                        args.push("-o".to_string());
                        args.push(format!("{}={}", key, value));
                        added_keys.insert(key.to_lowercase());
                    }
                }
            }
        }
    }

    // Fetch lpoptions for this printer to detect capabilities.
    let lpoptions_output: Option<String> = std::process::Command::new("lpoptions")
        .args(["-p", printer_name, "-l"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned());

    // Add media type from explicit options if not already in cups_options.
    if let Some(opts) = options {
        if let Some(ref media_type) = opts.media_type {
            if !media_type.trim().is_empty()
                && !added_keys.contains("mediatype")
                && !added_keys.contains("cnijmediatype")
                && !added_keys.contains("epij_medi")
                && !added_keys.contains("stpmediatype")
            {
                if let Some(ref output_str) = lpoptions_output {
                    let key = crate::print::unix::detect_media_type_key(output_str);
                    args.push("-o".to_string());
                    args.push(format!("{}={}", key, media_type.trim()));
                    added_keys.insert(key.to_lowercase());
                }
            }
        }
    }

    // Always detect and add the driver color bypass (not gated on
    // ppd_uncorrected_passthrough). If cups_options already contains a color
    // bypass key, skip this to avoid duplicates.
    let color_bypass_keys = [
        "cnijintent2",
        "cnijintent",
        "epij_ccor",
        "epij_oscolmat",
        "colorcorrection",
        "stpcolorcorrection",
        "epsoncolormode",
    ];
    let has_color_bypass = added_keys
        .iter()
        .any(|k| color_bypass_keys.contains(&k.as_str()));
    if !has_color_bypass {
        if let Some(ref output_str) = lpoptions_output {
            if let Some((bypass_key, bypass_val)) =
                crate::print::unix::detect_driver_color_bypass(output_str)
            {
                args.push("-o".to_string());
                args.push(format!("{}={}", bypass_key, bypass_val));
                added_keys.insert(bypass_key.to_lowercase());
            }
        }
    }

    // Add orientation and paper size from explicit options if not already
    // present in cups_options.
    if let Some(opts) = options {
        if let Some(ref orient) = opts.orientation {
            if !added_keys.contains("orientation-requested") {
                args.push("-o".to_string());
                if orient.eq_ignore_ascii_case("landscape") {
                    args.push("orientation-requested=4".to_string());
                } else {
                    args.push("orientation-requested=3".to_string());
                }
                added_keys.insert("orientation-requested".to_string());
            }
        }

        if let Some(ref page_size) = opts.paper_size {
            if !page_size.trim().is_empty() && !added_keys.contains("pagesize") {
                args.push("-o".to_string());
                args.push(format!("PageSize={}", page_size.trim()));
                added_keys.insert("pagesize".to_string());
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

/// Open the native macOS `NSPrintPanel` for the selected printer.
///
/// The panel is pre-configured with `AP_ColorMatchingMode=AP_ApplicationColorMatching`
/// so the driver's color-management controls are greyed out (application manages
/// color). On OK, the user's media type / quality choices are captured and
/// returned as a `PrintOptions` snapshot for the frontend to feed back into
/// `print_target_native`.
///
/// This function dispatches the dialog to the Cocoa main thread via
/// `AppHandle::run_on_main_thread` and awaits the result.
pub async fn show_printer_properties(
    printer_name: &str,
    app: &tauri::AppHandle,
) -> Result<PrintOptions, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<PrintOptions, String>>();
    let printer_name_owned = printer_name.to_string();

    app.run_on_main_thread(move || {
        let result = run_native_print_panel(&printer_name_owned);
        let _ = tx.send(result);
    })
    .map_err(|e| format!("Failed to dispatch print panel to main thread: {}", e))?;

    rx.await
        .map_err(|e| format!("Print panel channel closed unexpectedly: {}", e))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_filter_cups_options_string_basic() {
        let raw = "MediaType=92 EPIJ_CCor=0 com.apple.print.PrintSettings.PMCopies..n.=1 collate=False PageSize=A4 AP_ColorMatchingMode=AP_ApplicationColorMatching AP_D_InputSlot= copies=1";
        let filtered = filter_cups_options_string(raw).unwrap();
        // Should contain MediaType, EPIJ_CCor, PageSize but not com.apple.*,
        // collate, copies, AP_ColorMatchingMode, or empty AP_D_InputSlot.
        assert!(filtered.contains("MediaType=92"));
        assert!(filtered.contains("EPIJ_CCor=0"));
        assert!(filtered.contains("PageSize=A4"));
        assert!(!filtered.contains("com.apple."));
        assert!(!filtered.contains("collate"));
        assert!(!filtered.contains("copies"));
        assert!(!filtered.contains("AP_ColorMatchingMode"));
        assert!(!filtered.contains("AP_D_InputSlot"));
    }

    #[test]
    fn test_filter_cups_options_string_empty() {
        let raw = "com.apple.print.PrintSettings.PMCopies..n.=1 collate=False";
        assert!(filter_cups_options_string(raw).is_none());
    }

    #[test]
    fn test_extract_media_type_from_options() {
        let opts = "MediaType=92 EPIJ_CCor=0 PageSize=A4";
        assert_eq!(
            extract_media_type_from_options(opts),
            Some("92".to_string())
        );

        let opts2 = "EPIJ_Medi=13 PageSize=A4";
        assert_eq!(
            extract_media_type_from_options(opts2),
            Some("13".to_string())
        );

        let opts3 = "PageSize=A4";
        assert_eq!(extract_media_type_from_options(opts3), None);
    }

    #[test]
    fn test_build_lp_args_with_cups_options() {
        let opts = PrintOptions {
            cups_options: Some("MediaType=92 EPIJ_CCor=0 PageSize=A4".to_string()),
            ppd_uncorrected_passthrough: Some(true),
            ..Default::default()
        };
        let args = build_lp_args("Test_Printer", "/tmp/target.tif", Some(&opts));
        assert!(args.contains(&"AP_ColorMatchingMode=AP_ApplicationColorMatching".to_string()));
        assert!(args.contains(&"MediaType=92".to_string()));
        assert!(args.contains(&"EPIJ_CCor=0".to_string()));
        assert!(args.contains(&"PageSize=A4".to_string()));
        assert_eq!(args.last().unwrap(), "/tmp/target.tif");
    }

    #[test]
    fn test_build_lp_args_no_duplicate_media_type() {
        // When cups_options contains a MediaType, the explicit media_type
        // field should NOT also be added.
        let opts = PrintOptions {
            cups_options: Some("MediaType=92".to_string()),
            media_type: Some("13".to_string()),
            ..Default::default()
        };
        let args = build_lp_args("Test_Printer", "/tmp/target.tif", Some(&opts));
        // Should contain MediaType=92 (from cups_options) but NOT MediaType=13
        assert!(args.contains(&"MediaType=92".to_string()));
        assert!(!args.contains(&"MediaType=13".to_string()));
    }

    #[test]
    fn test_build_lp_args_no_duplicate_color_bypass() {
        // When cups_options contains a color bypass key, the auto-detected
        // bypass should NOT also be added.
        let opts = PrintOptions {
            cups_options: Some("EPIJ_CCor=0".to_string()),
            ..Default::default()
        };
        let args = build_lp_args("Test_Printer", "/tmp/target.tif", Some(&opts));
        // Should contain EPIJ_CCor=0 exactly once (from cups_options).
        let count = args.iter().filter(|a| *a == "EPIJ_CCor=0").count();
        assert_eq!(count, 1);
    }

    #[test]
    fn test_build_lp_args_colorsync_always_present() {
        // Even with no options, AP_ColorMatchingMode should be present.
        let args = build_lp_args("Test_Printer", "/tmp/target.tif", None);
        assert!(args.contains(&"AP_ColorMatchingMode=AP_ApplicationColorMatching".to_string()));
    }

    #[test]
    fn test_build_lp_args_orientation_not_duplicated() {
        let opts = PrintOptions {
            cups_options: Some("orientation-requested=4".to_string()),
            orientation: Some("portrait".to_string()),
            ..Default::default()
        };
        let args = build_lp_args("Test_Printer", "/tmp/target.tif", Some(&opts));
        // Should contain orientation-requested=4 from cups_options, but NOT
        // orientation-requested=3 from the explicit portrait setting.
        assert!(args.contains(&"orientation-requested=4".to_string()));
        assert!(!args.contains(&"orientation-requested=3".to_string()));
    }
}
