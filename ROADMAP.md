# ICCery Development Roadmap & Architecture Strategy

This document outlines the architectural roadmap, completed milestones, and upcoming development goals for **ICCery**.

> [!NOTE]
> Authoritative milestone and issue tracking lives in **Gitea Issues → Milestones**.

---

## 1. Architecture Summary

ICCery is a native, cross-platform desktop application built with:
- **Backend**: Rust + Tauri v2, managing asynchronous process pipes, native printer devmode configurations (Windows GDI & Linux CUPS), and filesystem operations.
- **Frontend**: Vanilla JS (ES Modules) + HTML5/CSS3 with a modern dark theme and responsive layout.
- **Visualization**: Three.js WebGL engine for 3D CIELAB color gamut volumes and sRGB reference comparisons.
- **Engine**: ArgyllCMS command-line utilities orchestrated over isolated standard stream IPC (`stdin`, `stdout`, `stderr`).

---

## 2. Completed Milestones

### Milestone 1 — Core Scaffolding & Subprocess Engine (`v0.1.0`)
- [x] Initialized Tauri v2 + Rust multi-threaded asynchronous process manager.
- [x] Implemented non-blocking event-driven stream pipes (`process:stdout`, `process:stderr`, `process:exit`).
- [x] Established strict AGPLv3 isolation boundary.

### Milestone 2 — Patch Set & Target Generation (`v0.1.3`)
- [x] Integrated Stage 1 `targen` for RGB/CMYK patch generation with presets and neutral axis boosting.
- [x] Integrated Stage 2 `printtarg` multi-page layout generation for major spectrophotometers (i1Pro, i1Pro2, ColorMunki, SpyderPrint).
- [x] Built working directory resolution and cross-platform binary detection.

### Milestone 3 — Interactive Measurement & Live Delta E (`v0.1.6`)
- [x] Developed bidirectional `chartread -u` state machine with prompt-driven calibration and strip reading.
- [x] Real-time JSON stream parsing (`ROW_COLORS_JSON`) for dynamic swatch grid updates.
- [x] Implemented live CIEDE2000 ($\Delta E_{00}$) calculation with traffic light quality indicators.

### Milestone 4 — Profile Calculation & Quality Verification (`v0.1.9`)
- [x] Integrated Stage 4 `colprof` cLUT profile mathematical generation.
- [x] Integrated Stage 5 `profcheck` numerical verification report (Peak, Average, RMS $\Delta E$).
- [x] Added automated dark-theme UI with responsive status indicators.

### Milestone 5 — Native OS Printing & Previews (`v0.1.13`)
- [x] Added raw unmanaged print pipelines (Windows GDI unmanaged printing + Linux CUPS `raw` queue printing).
- [x] Added high-resolution base64 TIFF thumbnail rendering pipeline.
- [x] Optimized window constraints to 1280×800 minimum bounds.

### Milestone 6 — 3D Gamut Visualization & Platform Extension Handling (`v0.1.14`)
- [x] Extracted `.gam` gamut datasets via `iccgamut` and integrated 3D CIELAB WebGL viewer.
- [x] Bundled reference `sRGB.gam` wireframe overlay for comparative volume analysis.
- [x] Resolved platform profile extensions (`.icm` on Windows vs. `.icc` on Unix).

### Milestone 7 — Wizard Disk-Artefact Gating & v0.2 Ship (`v0.2.0`)
- [x] Implemented disk-artefact gating for wizard stepper navigation (`.ti1` → `.ti2` → `.ti3` → `.icc`/`.icm`).
- [x] Eliminated all hardcoded placeholder and fallback crutches across JavaScript modules.
- [x] Comprehensive documentation, release testing, and packaging automation.

### Hotfix Release (`v0.2.1`)
- [x] Resolved P0 process manager deadlock and premature stdin pipe closure affecting interactive `chartread` instrument workflows.
- [x] Decoupled `ChildStdin` mutex management from child process wait/reap tasks.

### Milestone 8 — Advanced Measurement & Workflow Enhancements (`v0.3.0`)
- [x] **Averaging & Multi-Pass Reading**: Integrated Argyll `average` multi-pass measurement sheet workflow for noise reduction.
- [x] **Instrument Auto-Detection**: Added hardware detection via `instlist`.
- [x] **Preset Management**: Save, load, export, and import profiling recipes.
- [x] **Full 3D Convex Hull in CIELAB**: Replaced 2D projected Delaunay triangulation with full 3D QuickHull in Lab space with touch rotation controls.

### Maintenance & Hotfix Releases (`v0.3.1` – `v0.3.6`)
- [x] **v0.3.1 (#103)**: Stage 1 file browse via backend `select_target_file` dialog.
- [x] **v0.3.2 (#108)**: Linux CI runner compatibility updated to Ubuntu 22.04 LTS so `.deb` packages run without requiring newer GLIBC versions.
- [x] **v0.3.3 (#127)**: ArgyllCMS binary sidecars dynamically fetched at build time from `Gronod/argyllcms` releases; removed vendored binaries from repository; added Windows NSIS USB instrument driver installer hook.
- [x] **v0.3.4 & v0.3.5 (#119, #134)**: TIFF preview metadata extraction, printtarg custom patch labels, and robust `instlist` JSON parsing.
- [x] **v0.3.6 (#137)**: Interactive `chartread` support for multi-key prompts (accept/override key combos).

### Milestone 10 — Production Ready Features (`v0.5.0` – `v0.5.5`)
- [x] **Structured Logging (#139)**: Integrated `tauri-plugin-log` with rotating logs in native OS app log directory and ArgyllCMS stdout/stderr stream capture.
- [x] **Stage 3 Direct Resume (#140)**: Open existing `.ti2` target file in Stage 1 to parse header metadata and jump directly to Stage 3 (Measurement).
- [x] **Stage 1 Additional Customisation & Tooltips (#141)**: Exposure of 11 advanced `targen` tuning parameters (`-g`, `-s`, `-n`, `-c`, `-N`, `-G`, `-A`, algorithm selection, `-l`, `-V`, `-p`) in a collapsible section with contextual guidance tooltips and preset support.
- [x] **Subprocess Lifecycle & Clean Exit (#147, #149)**: Tauri application and window close hooks invoking `ProcessManager::kill_all` to prevent orphaned hardware-locking processes.
- [x] **Stage 1 Layout Normalization & Stage 2 Deterministic Target Generation (#162, #163)** (`v0.5.5`): Reorganized Stage 1 Advanced Options into structured 2-column grids with normalized heights; enforced deterministic `-R 1` target generation with custom seed and raster order (`-r`) support in Stage 2.
- [x] **macOS Universal Binary Target (#164)** (`v0.5.5`): Added macOS Universal Binary (`universal-apple-darwin`) build target combining Intel (`x86_64`) and Apple Silicon (`arm64`), ArgyllCMS universal sidecar packaging, runtime fallback resolution, and CI release asset automation.

### Milestone 11 — Enterprise Colour Workflow (`v0.6.0` – `v0.7.2`)
- [x] **macOS Driver Colour Management Bypass & Media Type Selection (#188)** (`v0.7.2`): Direct media type extraction via PPD/`lpoptions`, vendor uncorrected color bypass detection (Canon `CNIJIntent2`, Epson `ColorCorrection`), `AP_ColorMatchingMode=AP_ApplicationColorMatching` ColorSync suppression, CUPS printer management links, and Media Type selection UI.
- [x] **3D Gamut Visualisation Rework (#185)** (`v0.7.1`): Purpose-built CIELAB axis scaffold with tick marks and crisp CSS2D HTML text labels, clean sRGB reference rendering using `THREE.EdgesGeometry` with faint transparent solid volume, per-vertex true-colour profile gamut shading via `labToSrgb()`, and glassmorphic legend overlay with independent layer visibility toggles.
- [x] **Workflow & Visualizer Enhancements (#176, #177, #178, #179)** (`v0.7.0`): Stage 4 OBA/FWA compensation and viewing conditions UI (`-c`, `-d`), global button standardization, Stage 3 swatch grid diagonal split rendering for CIEDE2000 visual comparison, and robust gamut `.gam` dual-table face parsing with regex fixes for profcheck.
- [x] **CGATS Dataset Interoperability (#94)** (`v0.6.0`): Native Rust CGATS and Argyll `.ti3` dataset parser, canonical normalizer (0-255 scaling, field aliasing, metadata synthesis), and direct-jump workflow to Stage 4 (Profile Generation) and Stage 5 (Verification) using imported external datasets.
- [x] **Stage 1 Layout Normalization (#162)** (`v0.6.1`): Standardized control heights and structural flexbox auto-margin layout for multi-column Stage 1 advanced settings.
- [x] **Overlay Tooltip Rendering (#171)** (`v0.6.2`): Rendered tooltips as absolute overlay popups on hover/focus to prevent layout jitter while preserving in-flow hints in global tooltip toggle mode.
- [x] **Preconditioning Profile File Type Filter (#172)** (`v0.6.3`): Dedicated `select_profile_file` command allowing selection of `.icc`, `.icm`, and `.mpp` files for Stage 1 preconditioning profile input.
- [x] **Windows Authenticode Code Signing in Gitea CI** (`v0.6.4` – `v0.6.6`): Integrated Tauri bundle signing hooks via `sign.cmd` batch wrapper with PATH resolution, Gitea Actions secret-based PFX materialization, and ephemeral signing pipeline.
- [x] **Stage 3 Chartread Completion & Snapshot IPC Fix (#175)** (`v0.6.7` – `v0.6.8`): Added dedicated `Done & Save .ti3` action (`d\n`), `Undo Strip` action (`u\n`), automated completion state detection, and corrected Tauri IPC deserialization parameter (`passIndex`) in `snapshot_ti3`.

---

## 3. Future Roadmap

### Milestone 9 — macOS Native Support & Enhanced Print Spooling (`v0.4.0`)
- [ ] **macOS Platform Bundle**: Build and sign universal macOS `.dmg` bundles with notarization.
- [ ] **macOS Raw Spooling**: Native CoreGraphics/CUPS raw print dialog bypass.
- [ ] **SpectroScan & Automated Table Support (#93)**: Support XY automated scanning tables (i1iO / SpectroScan) in `chartread` (deferred).

### Milestone 12 — Future Workflow & Advanced Analytics (Deferred)
- [ ] **Batch Verification & Drift Tracking (#95)**: Track printer drift over time by comparing periodic verification measurements against a baseline profile.
- [ ] **Multi-Language Localization (#96)**: Full UI internationalization (English, German, French, Japanese).
