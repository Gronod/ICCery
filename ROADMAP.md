# ICCery Development Roadmap & Architecture Strategy

This document outlines the architectural roadmap, completed milestones, and upcoming development goals for **ICCery**.

---

## 1. Architecture Summary

ICCery is a native, cross-platform desktop application built with:
- **Backend**: Rust + Tauri v2, managing asynchronous process pipes, native printer devmode configurations (Windows GDI & Linux CUPS), and filesystem operations.
- **Frontend**: Vanilla JS (ES Modules) + HTML5/CSS3 with a modern dark theme and responsive layout.
- **Visualisation**: Three.js WebGL engine for 3D CIELAB color gamut volumes and sRGB reference comparisons.
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

---

## 3. Future Roadmap

### Milestone 8 — Advanced Measurement & Workflow Enhancements (`v0.3.0`)
- [ ] **Averaging & Multi-Pass Reading**: Integrate Argyll's `average` utility to merge multiple measurement sheets for enhanced accuracy.
- [ ] **Ambient & Display Profiling**: Extend wizard beyond reflective targets to emissive displays (`dispwin`, `dispread`).
- [ ] **Preset Management**: Save and load reusable profiling recipes (paper types, patch counts, quality presets).
- [ ] **Full 3D Convex Hull in CIELAB**: Replace 2D projected Delaunay triangulation with full 3D Delaunay/Convex Hull in Lab space for complex non-convex gamuts.

### Milestone 9 — macOS Native Support & Enhanced Print Spooling (`v0.4.0`)
- [ ] **macOS Platform Bundle**: Build and sign universal macOS `.dmg` bundles.
- [ ] **macOS Raw Spooling**: Native CoreGraphics/CUPS raw print dialog bypass.
- [ ] **SpectroScan & Automated Table Support**: Support XY automated scanning tables in `chartread`.

### Milestone 10 — Enterprise Colour Workflow (`v1.0.0`)
- [ ] **Custom CGATS Export**: Export and import industry-standard `.ti3` / `.txt` CGATS datasets.
- [ ] **Batch Verification & Drift Tracking**: Track printer drift over time by comparing periodic verification measurements against a baseline profile.
- [ ] **Multi-Language Localization**: Full UI internationalization (English, German, French, Japanese).
