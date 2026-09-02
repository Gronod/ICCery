# ICCery Agent Notes

## Build Commands

- **Rust backend**: `cd src-tauri && CARGO_INCREMENTAL=0 cargo check` (the project lives on a network filesystem that doesn't support file locking, so `CARGO_INCREMENTAL=0` is required)
- **Rust tests**: `cd src-tauri && CARGO_INCREMENTAL=0 cargo test`
- **Frontend**: `cd src-tauri && npm run build` (or `npm run dev` for development)

## Architecture Overview

- **Backend**: Rust + Tauri v2 (`src-tauri/`)
- **Frontend**: Vanilla JS modules (`src/js/`), HTML (`src/index.html`)
- **Print subsystem**: Platform-specific code under `src-tauri/src/print/`
  - `mod.rs`: Shared types (`PrintOptions`, `Printer`, `PrinterCapabilities`, `PrinterDevModeStore`)
  - `macos.rs`: macOS-specific `lp` spooling and native `NSPrintPanel` integration
  - `unix.rs`: Generic Unix/CUPS utilities (printer enumeration, PPD parsing, `lp` args)
  - `windows.rs`: Windows-specific printing via Win32 API and DEVMODE

## Cross-Platform `Printer` Field Notes

When adding fields to `Printer` in `src-tauri/src/print/mod.rs`, update every platform-specific constructor in `src-tauri/src/print/windows.rs`, `src-tauri/src/print/macos.rs`, and `src-tauri/src/print/unix.rs` to avoid build regressions on any target. Use `..Default::default()` where possible, or explicitly provide values (e.g. `display_name: None` on Windows).

## macOS Print Properties (Issue #188)

The "Preferences" button opens the native macOS `NSPrintPanel` (not CUPS web UI or System Settings).
- The CUPS destination ID is bound to the panel via Core Printing `PMPrinterCreateFromPrinterID` and `PMSessionSetCurrentPMPrinter`
- A `Printer.display_name` (from CUPS `printer-info`) is cached at enumeration as a fallback for `NSPrinter::printerWithName`
- Pre-configured with both `AP_ColorMatchingMode=AP_ApplicationColorMatching` and `AP.ColorMatchingMode=AP_ApplicationColorMatching` (dot-notation) as a locked PMPrintSettings value and in the `NSPrintInfo` job ticket
- Uses the private Core Printing `PMSessionSetColorMatchingMode` / `PMSessionSetColorMatchingModeLock` SPI (resolved at runtime via `dlsym`) to gray out and lock the Color Matching controls; falls back to the public setting if the SPI is absent
- Pre-selects the driver-specific "no color adjustment" PPD option (Canon `CNIJIntent2=4`, Epson `EPIJ_CMat=3`, etc.) in the native panel and on the `lp` command line
- Captures user's media type / quality selections as a CUPS options string with `PMPrintSettingsToOptions`
- Returns a `PrintPropertiesResult` with the effective `selected_printer` and captured `PrintOptions`
- Cancellation is returned as `None`, not an error
- Captured options are stored in frontend `capturedCupsOptions` map and passed via `PrintOptions.cups_options`
- `build_lp_args` in `macos.rs` always adds both `-o AP_ColorMatchingMode=AP_ApplicationColorMatching` and `-o AP.ColorMatchingMode=AP_ApplicationColorMatching`, and forwards captured options

## Key Dependencies (macOS only)

- `objc2` 0.6 — MainThreadMarker, rc
- `objc2-app-kit` 0.3.2 — NSPrintPanel, NSPrintInfo, NSPrinter
- `objc2-foundation` 0.3.2 — NSString
- `objc2-core-foundation` 0.3.2 — CFString, CFType
- `objc2-application-services` 0.3.2 — PMCore (PMPrintSettings, PMPrinter, PMSession, etc.)

## PPD Option Detection

- Epson media type key: `EPIJ_Medi` (in addition to `CNIJMediaType`, `MediaType`, `StpMediaType`)
- Epson color bypass: `EPIJ_CMat=3` (Off / No Color Adjustment)
- Canon color bypass: `CNIJIntent2=4` or `CNIJIntent=4`
- Gutenprint: `StpColorCorrection=Uncorrected`
