#![allow(dead_code)]

use std::ffi::CStr;
use std::path::Path;
use std::ptr::NonNull;

use objc2_application_services::PMPrintSession;

use crate::print::{PrintOptions, PrintPropertiesResult};
pub use crate::print::unix::{get_printer_capabilities, get_printers};

extern "C" {
    fn free(ptr: *mut std::ffi::c_void);
}

/// Run `lpoptions -p <printer> -l` and return the raw PPD option listing,
/// or `None` if the command is not available or the printer is not found.
fn get_lpoptions_output(printer_name: &str) -> Option<String> {
    std::process::Command::new("lpoptions")
        .args(["-p", printer_name, "-l"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
}

#[cfg(target_os = "macos")]
extern "C" {
    fn dlsym(handle: *mut std::ffi::c_void, symbol: *const std::ffi::c_char) -> *mut std::ffi::c_void;
}

/// Set the Core Printing session's color matching mode to "application" and
/// lock it. This is the private SPI used by Photoshop, Lightroom and X-Rite
/// i1Profiler to gray-out the Color Matching controls in driver PDEs.
///
/// The symbols are resolved at runtime with `dlsym` so the binary does not
/// hard-depend on an undocumented symbol. We try multiple signature permutations
/// and mode constants because the exact signature is undocumented.
/// Known exports: PMSessionSetColorMatchingMode, PMSessionSetColorMatchingModeLock,
/// PMSessionSetColorMatchingModeNoLock.
#[cfg(target_os = "macos")]
unsafe fn set_session_color_matching_mode(pm_session: PMPrintSession) {
    use std::ffi::{c_char, c_int, c_void};
    use objc2_core_foundation::CFString;
    use objc2_application_services::{PMSessionGetCurrentPrinter, PMPrinter};

    if pm_session.is_null() {
        log::warn!("pm_session is null; skipping private color-matching SPI");
        return;
    }

    // Verify session has a printer attached
    let mut current_printer: PMPrinter = std::ptr::null_mut();
    let printer_status = PMSessionGetCurrentPrinter(pm_session, &mut current_printer);
    if printer_status != 0 || current_printer.is_null() {
        log::warn!(
            "PMSessionGetCurrentPrinter failed ({}) or returned null printer; skipping SPI",
            printer_status
        );
        return;
    }

    const RTLD_DEFAULT: *mut c_void = (-2isize) as *mut c_void;

    // Load all relevant symbols once
    let sym_main = c"PMSessionSetColorMatchingMode";
    let sym_lock = c"PMSessionSetColorMatchingModeLock";
    let sym_nolock = c"PMSessionSetColorMatchingModeNoLock";

    let main_ptr = dlsym(RTLD_DEFAULT, sym_main.as_ptr() as *const c_char);
    let lock_ptr = dlsym(RTLD_DEFAULT, sym_lock.as_ptr() as *const c_char);
    let nolock_ptr = dlsym(RTLD_DEFAULT, sym_nolock.as_ptr() as *const c_char);

    log::info!(
        "PMSessionSetColorMatchingMode SPI symbols: main={:p} lock={:p} nolock={:p}",
        main_ptr, lock_ptr, nolock_ptr
    );

    // Mode constants to try (order matters: most likely first)
    const MODES: &[&str] = &[
        "AP_ApplicationColorMatching",  // kPMApplicationColorMatching
        "AP_VendorColorMatching",       // kPMVendorColorMatching
        "AP_ColorSyncMatching",         // kPMColorSyncMatching
        "AP_NoColorMatching",           // hypothetical
        "ApplicationColorMatching",     // without AP_ prefix
    ];

    for &mode_str in MODES {
        let mode = CFString::from_str(mode_str);
        let mode_ptr = &*mode as *const CFString;

        // Attempt 1: 3-arg (session, mode, lock) — standard ordering
        if !main_ptr.is_null() && !lock_ptr.is_null() {
            log::info!(
                "Attempt 1: PMSessionSetColorMatchingMode(session, mode, lock) with {}",
                mode_str
            );
            type Fn3 = unsafe extern "C" fn(PMPrintSession, *const CFString, u8) -> c_int;
            let fn3: Fn3 = std::mem::transmute(main_ptr);
            let status = fn3(pm_session, mode_ptr, 1);
            log::info!("  → status = {}", status);
            if status == 0 {
                log::info!("Attempt 1 succeeded");
                return;
            }
        }

        // Attempt 2: 3-arg lock-first (session, lock, mode) — Carbon sometimes puts Boolean first
        if !main_ptr.is_null() && !lock_ptr.is_null() {
            log::info!(
                "Attempt 2: PMSessionSetColorMatchingMode(session, lock, mode) with {}",
                mode_str
            );
            type Fn3Rev = unsafe extern "C" fn(PMPrintSession, u8, *const CFString) -> c_int;
            let fn3rev: Fn3Rev = std::mem::transmute(main_ptr);
            let status = fn3rev(pm_session, 1, mode_ptr);
            log::info!("  → status = {}", status);
            if status == 0 {
                log::info!("Attempt 2 succeeded");
                return;
            }
        }

        // Attempt 3: 2-arg (session, mode) via main symbol
        if !main_ptr.is_null() {
            log::info!(
                "Attempt 3: PMSessionSetColorMatchingMode(session, mode) with {}",
                mode_str
            );
            type Fn2 = unsafe extern "C" fn(PMPrintSession, *const CFString) -> c_int;
            let fn2: Fn2 = std::mem::transmute(main_ptr);
            let status = fn2(pm_session, mode_ptr);
            log::info!("  → status = {}", status);
            if status == 0 {
                // Try to lock separately
                if !lock_ptr.is_null() {
                    type LockFn = unsafe extern "C" fn(PMPrintSession, u8) -> c_int;
                    let lock_fn: LockFn = std::mem::transmute(lock_ptr);
                    let lstatus = lock_fn(pm_session, 1);
                    log::info!("  → lock status = {}", lstatus);
                }
                log::info!("Attempt 3 succeeded");
                return;
            }
        }

        // Attempt 4: NoLock variant (session, mode) + separate lock
        if !nolock_ptr.is_null() {
            log::info!(
                "Attempt 4: PMSessionSetColorMatchingModeNoLock(session, mode) with {}",
                mode_str
            );
            type NoLockFn = unsafe extern "C" fn(PMPrintSession, *const CFString) -> c_int;
            let nolock_fn: NoLockFn = std::mem::transmute(nolock_ptr);
            let status = nolock_fn(pm_session, mode_ptr);
            log::info!("  → status = {}", status);
            if status == 0 {
                if !lock_ptr.is_null() {
                    type LockFn = unsafe extern "C" fn(PMPrintSession, u8) -> c_int;
                    let lock_fn: LockFn = std::mem::transmute(lock_ptr);
                    let lstatus = lock_fn(pm_session, 1);
                    log::info!("  → lock status = {}", lstatus);
                }
                log::info!("Attempt 4 succeeded");
                return;
            }
        }
    }

    log::warn!(
        "All PMSessionSetColorMatchingMode variants and mode constants exhausted; color controls will not be grayed"
    );
}

#[cfg(not(target_os = "macos"))]
unsafe fn set_session_color_matching_mode(_pm_session: PMPrintSession) {}



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
    "EPIJ_CMat",
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
    // We always set AP_ColorMatchingMode (and dot-notation) ourselves in build_lp_args.
    if key == "AP_ColorMatchingMode" || key == "AP.ColorMatchingMode" {
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
/// greyed out. Returns the user-selected printer and captured print settings as
/// a `PrintPropertiesResult` snapshot, or `None` if the user cancelled the
/// dialog.
///
/// This function must be called on the Cocoa main thread. The caller is
/// responsible for dispatching via `AppHandle::run_on_main_thread`.
fn run_native_print_panel(
    printer_name: &str,
    display_name: Option<&str>,
) -> Result<Option<PrintPropertiesResult>, String> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSPrintInfo, NSPrintPanel, NSPrintPanelOptions, NSPrinter};
    use objc2_application_services::{
        PMPageFormat, PMPrinter, PMPrinterCreateFromPrinterID,
        PMPrinterGetID, PMPrintSettings, PMPrintSettingsSetValue,
        PMPrintSettingsToOptions, PMRelease, PMSessionDefaultPageFormat,
        PMSessionDefaultPrintSettings, PMSessionGetCurrentPrinter,
        PMSessionSetCurrentPMPrinter,
    };
    use objc2_core_foundation::CFString;
    use objc2_foundation::NSString;

    let mtm = MainThreadMarker::new()
        .ok_or("Print panel must be invoked on the main thread")?;

    // Create a fresh NSPrintInfo and initialize it.
    let print_info = NSPrintInfo::new();
    print_info.setUpPrintOperationDefaultValues();

    // Bind the CUPS destination (Printer ID) to the session. CUPS destination
    // IDs are what macOS Core Printing calls "Printer IDs"; they are not the
    // human-readable display names used by NSPrinter::printerWithName.
    let printer_id_cf = CFString::from_str(printer_name);
    let pm_printer: PMPrinter = unsafe { PMPrinterCreateFromPrinterID(&*printer_id_cf) };
    let mut printer_from_id = !pm_printer.is_null();

    if pm_printer.is_null() {
        if let Some(dn) = display_name {
            // Fallback: try the human-readable display name via NSPrinter. This is
            // less robust than a direct PMPrinter lookup but allows the panel to
            // open when the queue is not currently registered in the Core Printing
            // session under its CUPS ID.
            let name_ns = NSString::from_str(dn);
            if let Some(ns_printer) = NSPrinter::printerWithName(&name_ns) {
                print_info.setPrinter(&ns_printer);
                print_info.setUpPrintOperationDefaultValues();
            } else {
                return Err(format!(
                    "No printer found for '{}' (display name: {:?})",
                    printer_name, display_name
                ));
            }
        } else {
            return Err(format!(
                "No printer found for '{}' (display name: {:?})",
                printer_name, display_name
            ));
        }
    }

    // Obtain the underlying Core Printing session and settings now that
    // NSPrintInfo has been configured. These are valid as long as `print_info`
    // is retained.
    let pm_session: PMPrintSession = print_info.PMPrintSession().as_ptr() as PMPrintSession;
    let pm_settings: PMPrintSettings = print_info.PMPrintSettings().as_ptr() as PMPrintSettings;
    let pm_page_format = print_info.PMPageFormat().as_ptr() as PMPageFormat;

    if !pm_printer.is_null() {
        let set_status = unsafe { PMSessionSetCurrentPMPrinter(pm_session, pm_printer) };
        if set_status != 0 {
            unsafe { PMRelease(pm_printer as _) };
            return Err(format!(
                "PMSessionSetCurrentPMPrinter failed with status {}",
                set_status
            ));
        }

        let default_status = unsafe { PMSessionDefaultPrintSettings(pm_session, pm_settings) };
        if default_status != 0 {
            log::warn!(
                "PMSessionDefaultPrintSettings returned status {}",
                default_status
            );
        }

        let default_page_status = unsafe { PMSessionDefaultPageFormat(pm_session, pm_page_format) };
        if default_page_status != 0 {
            log::warn!(
                "PMSessionDefaultPageFormat returned status {}",
                default_page_status
            );
        }
    }

    // Use the private PMSessionSetColorMatchingMode SPI to gray out and lock
    // the Color Matching controls in the driver PDE (ColorSync vs. vendor
    // color). This is separate from the AP_ColorMatchingMode spool setting.
    unsafe { set_session_color_matching_mode(pm_session); }

    // Set AP_ColorMatchingMode = AP_ApplicationColorMatching (and the
    // dot-notation variant) so the CUPS backend/cgpdftoraster knows the
    // application already handled color matching.
    let cm_key = CFString::from_str("AP_ColorMatchingMode");
    let cm_dot_key = CFString::from_str("AP.ColorMatchingMode");
    let cm_val = CFString::from_str("AP_ApplicationColorMatching");
    let cm_val_ref: &objc2_core_foundation::CFType = &*cm_val;
    for cm_key_ref in [&cm_key, &cm_dot_key] {
        let set_status = unsafe {
            PMPrintSettingsSetValue(pm_settings, cm_key_ref, Some(cm_val_ref), true)
        };
        if set_status != 0 {
            log::warn!(
                "PMPrintSettingsSetValue({}) returned status {}",
                cm_key_ref,
                set_status
            );
        }
    }

    // Pre-select the driver-specific "no color adjustment" PPD option in the
    // print settings so the panel shows it as the current choice.
    let lpoptions = get_lpoptions_output(printer_name);
    if let Some(ref output) = lpoptions {
        if let Some((bypass_key, bypass_val)) =
            crate::print::unix::detect_driver_color_bypass(output)
        {
            let bypass_key_cf = CFString::from_str(bypass_key);
            let bypass_val_cf = CFString::from_str(bypass_val);
            let bypass_val_ref: &objc2_core_foundation::CFType = &*bypass_val_cf;
            let set_status = unsafe {
                PMPrintSettingsSetValue(pm_settings, &bypass_key_cf, Some(bypass_val_ref), false)
            };
            if set_status != 0 {
                log::warn!(
                    "PMPrintSettingsSetValue({}={}) returned status {}",
                    bypass_key, bypass_val, set_status
                );
            }
        }
    }

    print_info.updateFromPMPageFormat();

    // Sync the PMPrintSettings changes back into the NSPrintInfo object.
    print_info.updateFromPMPrintSettings();

    // Also write the color-matching keys directly into the NSPrintInfo
    // printSettings dictionary. This is the dictionary that AppKit print
    // dialog extensions (PDEs) and some raster drivers inspect, so the
    // value must appear here as well as in the PMPrintSettings object.
    let cm_key_ns = NSString::from_str("AP_ColorMatchingMode");
    let cm_dot_key_ns = NSString::from_str("AP.ColorMatchingMode");
    let cm_val_ns = NSString::from_str("AP_ApplicationColorMatching");

    // Safety: `NSString` has the same memory layout as its root `AnyObject`
    // (`isa`), so we can borrow it as `&AnyObject` for the dictionary.
    let as_any = |s: &NSString| -> &objc2::runtime::AnyObject {
        unsafe { &*(s as *const _ as *const objc2::runtime::AnyObject) }
    };

    let print_settings = unsafe { print_info.printSettings() };
    print_settings.insert(&*cm_key_ns, as_any(&*cm_val_ns));
    print_settings.insert(&*cm_dot_key_ns, as_any(&*cm_val_ns));

    // Also surface the driver-specific color bypass in printSettings so the
    // panel PDE sees it even if PMPrintSettings didn't sync it.
    if let Some(ref output) = lpoptions {
        if let Some((bypass_key, bypass_val)) =
            crate::print::unix::detect_driver_color_bypass(output)
        {
            let bypass_key_ns = NSString::from_str(bypass_key);
            let bypass_val_ns = NSString::from_str(bypass_val);
            print_settings.insert(&*bypass_key_ns, as_any(&*bypass_val_ns));
        }
    }

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
        if !pm_printer.is_null() {
            unsafe { PMRelease(pm_printer as _) };
        }
        return Ok(None);
    }

    // Capture the effective printer from the session.
    let mut current_printer: PMPrinter = std::ptr::null_mut();
    let get_status = unsafe {
        PMSessionGetCurrentPrinter(
            pm_session,
            NonNull::new(&mut current_printer).unwrap(),
        )
    };
    let selected_printer = if get_status == 0 && !current_printer.is_null() {
        unsafe {
            PMPrinterGetID(current_printer).map(|id| format!("{}", id))
        }
    } else {
        if printer_from_id {
            Some(printer_name.to_string())
        } else {
            None
        }
    };

    // Extract the updated print settings from the panel.
    let updated_info = panel.printInfo();
    let updated_settings: PMPrintSettings =
        updated_info.PMPrintSettings().as_ptr() as PMPrintSettings;

    let mut opts_ptr: *mut std::ffi::c_char = std::ptr::null_mut();
    let to_opts_status = unsafe {
        PMPrintSettingsToOptions(updated_settings, NonNull::new(&mut opts_ptr).unwrap())
    };

    if to_opts_status != 0 || opts_ptr.is_null() {
        if !pm_printer.is_null() {
            unsafe { PMRelease(pm_printer as _) };
        }
        return Err(format!(
            "PMPrintSettingsToOptions failed with status {}",
            to_opts_status
        ));
    }

    let opts_cstr = unsafe { CStr::from_ptr(opts_ptr) };
    let opts_str = opts_cstr.to_string_lossy().into_owned();
    unsafe { free(opts_ptr as *mut _) };
    if !pm_printer.is_null() {
        unsafe { PMRelease(pm_printer as _) };
    }

    // Filter to PPD-relevant options.
    let cups_options = filter_cups_options_string(&opts_str);

    // Try to extract a media type from the captured options.
    let media_type = cups_options
        .as_ref()
        .and_then(|s| extract_media_type_from_options(s));

    Ok(Some(PrintPropertiesResult {
        selected_printer,
        options: PrintOptions {
            media_type,
            cups_options,
            ppd_uncorrected_passthrough: Some(true),
            ..Default::default()
        },
    }))
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

    // Always apply ColorSync bypass on macOS for targeting. The dot-notation
    // variant is a legacy form used by some raster drivers and PDEs.
    args.push("-o".to_string());
    args.push("AP_ColorMatchingMode=AP_ApplicationColorMatching".to_string());
    args.push("-o".to_string());
    args.push("AP.ColorMatchingMode=AP_ApplicationColorMatching".to_string());

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
    let lpoptions_output: Option<String> = get_lpoptions_output(printer_name);

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
        "epij_cmat",
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
/// returned as a `PrintPropertiesResult` snapshot for the frontend to feed back
/// into `print_target_native`.
///
/// This function dispatches the dialog to the Cocoa main thread via
/// `AppHandle::run_on_main_thread` and awaits the result.
pub async fn show_printer_properties(
    printer_name: &str,
    app: &tauri::AppHandle,
) -> Result<Option<PrintPropertiesResult>, String> {
    // Resolve the human-readable display name before entering the main thread
    // so we have a fallback if PMPrinterCreateFromPrinterID fails.
    let display_name = crate::print::unix::get_printer_display_name(printer_name);

    let (tx, rx) = tokio::sync::oneshot::channel::<Result<Option<PrintPropertiesResult>, String>>();
    let printer_name_owned = printer_name.to_string();
    let display_name_owned = display_name;

    app.run_on_main_thread(move || {
        let display_name_ref = display_name_owned.as_deref();
        let result = run_native_print_panel(&printer_name_owned, display_name_ref);
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
        let raw = "MediaType=92 EPIJ_CMat=3 com.apple.print.PrintSettings.PMCopies..n.=1 collate=False PageSize=A4 AP_ColorMatchingMode=AP_ApplicationColorMatching AP_D_InputSlot= copies=1";
        let filtered = filter_cups_options_string(raw).unwrap();
        // Should contain MediaType, EPIJ_CMat, PageSize but not com.apple.*,
        // collate, copies, AP_ColorMatchingMode, or empty AP_D_InputSlot.
        assert!(filtered.contains("MediaType=92"));
        assert!(filtered.contains("EPIJ_CMat=3"));
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
        let opts = "MediaType=92 EPIJ_CMat=3 PageSize=A4";
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
            cups_options: Some("MediaType=92 EPIJ_CMat=3 PageSize=A4".to_string()),
            ppd_uncorrected_passthrough: Some(true),
            ..Default::default()
        };
        let args = build_lp_args("Test_Printer", "/tmp/target.tif", Some(&opts));
        assert!(args.contains(&"AP_ColorMatchingMode=AP_ApplicationColorMatching".to_string()));
        assert!(args.contains(&"MediaType=92".to_string()));
        assert!(args.contains(&"EPIJ_CMat=3".to_string()));
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
            cups_options: Some("EPIJ_CMat=3".to_string()),
            ..Default::default()
        };
        let args = build_lp_args("Test_Printer", "/tmp/target.tif", Some(&opts));
        // Should contain EPIJ_CMat=3 exactly once (from cups_options).
        let count = args.iter().filter(|a| *a == "EPIJ_CMat=3").count();
        assert_eq!(count, 1);

        // Same for Canon's CNIJIntent2 path.
        let opts2 = PrintOptions {
            cups_options: Some("CNIJIntent2=4".to_string()),
            ..Default::default()
        };
        let args2 = build_lp_args("Test_Printer", "/tmp/target.tif", Some(&opts2));
        let count2 = args2.iter().filter(|a| *a == "CNIJIntent2=4").count();
        assert_eq!(count2, 1);
    }

    #[test]
    fn test_build_lp_args_colorsync_always_present() {
        // Even with no options, AP_ColorMatchingMode and the dot-notation
        // variant should be present.
        let args = build_lp_args("Test_Printer", "/tmp/target.tif", None);
        assert!(args.contains(&"AP_ColorMatchingMode=AP_ApplicationColorMatching".to_string()));
        assert!(args.contains(&"AP.ColorMatchingMode=AP_ApplicationColorMatching".to_string()));
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
