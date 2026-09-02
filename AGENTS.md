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

## macOS Print Properties (Issue #188)

The "Preferences" button opens the native macOS `NSPrintPanel` (not CUPS web UI or System Settings).
- Pre-configured with `AP_ColorMatchingMode=AP_ApplicationColorMatching` so driver color management is greyed out
- Captures user's media type / quality selections as a CUPS options string
- Captured options are stored in frontend `capturedCupsOptions` map and passed via `PrintOptions.cups_options`
- `build_lp_args` in `macos.rs` always adds `-o AP_ColorMatchingMode=AP_ApplicationColorMatching` and forwards captured options

## Key Dependencies (macOS only)

- `objc2` 0.6 — MainThreadMarker, rc
- `objc2-app-kit` 0.3.2 — NSPrintPanel, NSPrintInfo, NSPrinter
- `objc2-foundation` 0.3.2 — NSString
- `objc2-core-foundation` 0.3.2 — CFString
- `objc2-application-services` 0.3.2 — PMCore (PMPrintSettings, PMCreatePrintSettings, etc.)

## PPD Option Detection

- Epson media type key: `EPIJ_Medi` (in addition to `CNIJMediaType`, `MediaType`, `StpMediaType`)
- Epson color bypass: `EPIJ_CCor=0` or `EPIJ_OSColMat=0`
- Canon color bypass: `CNIJIntent2=4` or `CNIJIntent=4`
- Gutenprint: `StpColorCorrection=Uncorrected`
