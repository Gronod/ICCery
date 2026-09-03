# ICCery Agent Notes

## Stage 4 colprof Options

- `colprof` options are exposed in the Stage 4 UI with contextual tooltips:
  - **FWA / OBA Compensation** (`-f`): choose D50, None, D65, or a custom `.sp` spectrum file.
  - **Standard Illuminant** (`-i`) and **Observer** (`-o`): override default D50 / 1931 2° for CIE colourimetric calculations.
  - **Viewing Conditions** (`-c` input, `-d` output): set CIE viewing-condition transforms for the profile table and output intent.
- The backend `build_colprof_args` in `commands.rs` maps these UI values to `colprof` CLI flags. Unit tests cover all combinations.

## Stage 3 Swatch Grid

- Swatch patches render a 135° diagonal split: top-left is the intended/expected colour, bottom-right is the measured colour.
- Argyll `chartread` emits `is_pad` for boundary/spacer patches. White reference patches (e.g. `-e` white steps) may also carry `is_pad`, but they have valid `expected.Lab` or non-zero `device` data. The guard skips only pads with no measurement *and* all-zero device values.
- Row/patch order from `chartread` (rows A→Z, patches 1→N within each row) is rendered left-to-right / top-to-bottom to match the `printtarg` output.
- Tooltip shows intended Lab (or device %), measured Lab, and ΔE₀₀ with a Good/Warning/Bad classification.

## UI Button Conventions

The frontend uses a tiered button sizing system defined in `src/styles/main.css`. Prefer these utility classes over inline `style` attributes.

| Class | Size | Use for |
|-------|------|---------|
| `.btn-sm` | 28px | Toolbar actions, header icons, minor toggles |
| `.btn-md` (default for `button.secondary`/`button.danger`) | 36px | Standard dialog/form actions and browse buttons |
| `.btn-lg` | 40px | Primary stage actions (Generate, Create Layout, Create Profile, Verify, etc.) |
| `.btn-icon-sq` | 36×36px | Square icon-only buttons (refresh, settings, etc.) |
| `.icon-btn` | 28×28px | Small header icon-only buttons (settings, about, save preset, manage presets) |
| `.btn-properties` | 36px | Printer driver preferences button |

- Primary action buttons use `button.primary` plus `.btn-lg` for major stage actions.
- Danger actions use `button.danger` (36px).
- All action rows use one of: `.stage-actions`, `.modal-actions`, `.chartread-actions`, `.print-actions-row`, `.btn-row`, `.btn-row-sm`, `.btn-row-end`, or `.input-row-sm`.
- Avoid inline `style` on `<button>` elements or their immediate parent rows.

## Settings & Preferences

- Settings are persisted to `settings.json` in the app data directory and include the Stage 3 ΔE₀₀ traffic-light thresholds.
- Valid threshold values must be non-negative and `delta_e_good_max < delta_e_warning_max`; both the frontend and backend enforce this.
- Saving settings dispatches a `settings-saved` custom event so live components (e.g. the swatch grid) can re-classify on the fly.

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
- Uses the private Core Printing `PMSessionSetColorMatchingMode` / `PMSessionSetColorMatchingModeLock` / `PMSessionSetColorMatchingModeNoLock` SPI (resolved at runtime via `dlsym`) to gray out and lock the Color Matching controls; all three symbols use the 2-argument `(PMPrintSession, *const CFString)` signature; `PMSessionSetColorMatchingModeLock` sets and locks in one call; `NoLock` sets the mode without locking; falls back to the public `PMPrintSettingsSetValue` setting if the SPI is absent
- Pre-selects the driver-specific "no color adjustment" PPD option (Canon `CNIJIntent2=4`, Epson `EPIJ_CMat=3`, etc.) in the native panel and on the `lp` command line
- Captures user's media type / quality selections as a CUPS options string with `PMPrintSettingsToOptions`
- Returns a `PrintPropertiesResult` with the effective `selected_printer` and captured `PrintOptions`
- Cancellation is returned as `None`, not an error
- Captured options are stored in frontend `capturedCupsOptions` map and passed via `PrintOptions.cups_options`
- `build_lp_args` in `macos.rs` always adds both `-o AP_ColorMatchingMode=AP_ApplicationColorMatching` and `-o AP.ColorMatchingMode=AP_ApplicationColorMatching`, and forwards captured options
- Only `AP_ApplicationColorMatching` and `ApplicationColorMatching` are passed to the private SPI; `AP_ColorSyncMatching` and `AP_VendorColorMatching` are intentionally avoided because they would enable color management on profiling targets

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
