# ICCery Agent Notes

## Stage 5 Verification / Profcheck

- `profcheck` output is parsed from both JSON summaries (preferred) and legacy plain-text report formats.
- If no delta-E values can be detected, the report cards show 0.00 and a warning is appended to the process log.
- The `.gam` file for the 3D viewer is parsed using `parseGamutFile`, which supports multiple `BEGIN_DATA` blocks (some Argyll files use a separate block per surface section), inline `#` comments, and out-of-bounds vertex warnings.
- Manual parser tests live in `src/js/gamut_viewer.test.js`.

## 3D Gamut Viewer

- The viewer renders the measured/derived `.gam` volume and an optional sRGB reference wireframe in CIELAB.
- **Do not** create `THREE.WebGLRenderer` during `DOMContentLoaded`. Call `ensureGamutViewer()` from `state.js` only when Stage 5 becomes visible. Eager WebGL on a hidden canvas respawns WKWebView on macOS Monterey Intel (#225).
- Feature-detect WebGL first; missing/lost context must leave a fallback message in `#gamutViewerContainer` and must not take down the app.
- Pause the rAF loop when leaving Stage 5 (`pauseGamutViewer`).
- Layer controls (profile, sRGB, axes) each have visibility toggles and opacity sliders.
- Click **Reset View** or press **R** to return the camera to its default position.
- Full JSDoc is provided on the public API in `src/js/gamut_viewer.js`.

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

## Build & Test Commands

- **Rust backend check**: `cd src-tauri && CARGO_INCREMENTAL=0 cargo check` (the project lives on a network filesystem that doesn't support file locking, so `CARGO_INCREMENTAL=0` is required)
- **Rust unit tests**: `cd src-tauri && CARGO_INCREMENTAL=0 cargo test`
- **Frontend test suites**:
  - Verification & drift tests: `node src/js/profcheck.test.js` (21 tests)
  - Chartread classifier & XY table tests: `node src/js/chartread.test.js` (39 tests)
  - Gamut viewer tests: `node src/js/gamut_viewer.test.js`
  - Browser devtools console: `import('./profcheck.test.js').then(m => m.runAll())`
- **Frontend development server**: `npm run tauri dev`
- **Production package build**: `npm run tauri build`

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

## Verification History & Printer Drift Tracking (#95)

- Historical verification runs are stored in `verification_history.json` in the app data directory.
- Record schema (`VerificationRecord` in `src-tauri/src/quality_store.rs`):
  - `id`: unique record identifier in the format `vr-<epoch_millis>-<seq>`.
  - `profile_name`: target profile filename.
  - `printer_name`: device name captured at print spooling (`wizardState.printerName`), or "Unknown".
  - `avg_de`, `max_de`, `rms_de`: CIEDE2000 metrics from `profcheck` (using `-u` JSON summary).
  - `patch_count`: number of test patches evaluated.
  - `status`: classified status using **ICCery verification bands (issue #95)**:
    - `< 1.0`: "Excellent" (`badge-excellent`)
    - `< 2.0`: "Good" (`badge-good`)
    - `< 3.5`: "Acceptable" (`badge-acceptable`)
    - `>= 3.5`: "Warning" (`badge-poor`)
  - `timestamp`: ISO-8601 UTC string.
- Max capacity is 1,000 records; oldest records evicted on overflow.
- Atomic file writes (`.tmp` write followed by `rename`) prevent data corruption.
- Tauri IPC command casing:
  - Nested struct fields (`VerificationRecord`) serialize with `snake_case`.
  - Top-level Tauri command arguments use `camelCase` (e.g. `savePath`, `record`, `profileName`).
- Drift history UI in Stage 5 features an interactive SVG trend chart with ICCery verification reference bands, consecutive-breach alert card (requires $\ge 2$ consecutive runs $\ge 3.5$ on distinct calendar days or $\ge 1$ hour apart), and RFC-4180 compliant CSV export.

## Stage 3 XY Automated Scanning Tables (#93)

- Supports automated XY scanning tables (GretagMacbeth SpectroScan, X-Rite i1iO) in Stage 3 `chartread`.
- Hardware detection in `instlist` flags devices matching `/spectro\s?scan|i1io/i` with `data-xy="1"` and `· XY Table` label suffix.
- Runtime auto-detection activates when any XY-specific prompt is classified from `chartread` stdout (supporting i1iO units reporting as i1Pro).
- XY State Machine additions:
  - `STATE.TABLE_PLACE_SHEET`: Prompts user to place sheet on table; button displays "✓ Sheet Placed — Continue".
  - `STATE.TABLE_ALIGN`: Prompts user to align measurement head with target fiducial patches (`locate patch <ID> with sight`); button displays "✓ Aligned — Continue".
- Two-line prompt handling & sticky state:
  - Argyll `chartread.c` splits XY prompts across two lines (prompt line followed by `hit return to continue...`).
  - While in `TABLE_PLACE_SHEET` or `TABLE_ALIGN`, subsequent continuation lines remain sticky in that table state, preserving the custom button label and preventing regression to generic `PROMPT_CONTINUE`.
- Button behaviors:
  - `btnAccept`: in `TABLE_*` states, sends `\n` without forcing `STATE.READING`; the state machine advances naturally when Argyll emits the next prompt.
  - `btnCancel`: in `TABLE_*` states or when an XY table is active, sends `q\n` first to allow the hardware to park its measurement head gracefully before terminating the process.
- Multi-sheet and final sheet notice:
  - Multi-sheet targets are measured within a single `chartread` process lifecycle; sheet changes transition through `TABLE_PLACE_SHEET` without opening the Stage 3 multi-pass averaging panel.
  - `Please remove last sheet from table` is emitted by Argyll right before writing `.ti3` and exiting; it is classified as an info-only notice (`isRemoveSheetNotice: true`) and does not prompt for user input.
- Testing:
  - Pure line classification unit tests live in `src/js/chartread.test.js` (executable directly in Node or browser console).
  - Unix/macOS mock script `src-tauri/argyll/mocks/chartread.mock` supports `--xy` flag (or `MOCK_XY_TABLE=1`) with blocking `read` calls simulating calibration, sheet placement, fiducial alignment, and scanning.

## Stage 3 i1Pro 2 LED Status Feedback (#204)

- Supports the `-Y l` switch introduced in the ICCery ArgyllCMS fork to drive the dual RGB ring LEDs of the X-Rite i1Pro 2 (Rev E) for real-time visual status feedback during strip measurement:
  - **Flashing White**: Awaiting baseline calibration on white tile.
  - **Flashing Blue**: Ready for row swipe / awaiting strip read.
  - **Flashing Red**: Strip scan error / misread.
  - **Flashing Green**: Strip scan successfully captured.
- Controlled via `enable_i1pro2_leds: bool` in `AppSettings` (persisted in `settings.json`), exposed under Settings → Instrument & Measurement Preferences.
- Defaults to `false` ensuring 100% out-of-the-box compatibility with stock upstream ArgyllCMS binaries.
- Subprocess error diagnostics in `chartread.js` capture `lastStderrLine` from `process:stderr`, auto-expanding the Process Output `<details>` panel with the stderr explanation if an unpatched binary rejects `-Y l`.

## CI & Cross-Compilation

- Release packaging workflows live under `.gitea/workflows/` (`build-macos.yml`, `build-linux.yml`, `build-windows.yml`).
- Tag release builds focus exclusively on packaging via `npm run tauri build` without redundant debug-profile test compilations.
- Local/CI cross-compilation test execution for Apple Silicon (`aarch64-apple-darwin`) on Intel hosts must use `cargo test --no-run --target aarch64-apple-darwin` to avoid executing ARM64 binaries on an x86_64 CPU (`Bad CPU type in executable (os error 86)`).

