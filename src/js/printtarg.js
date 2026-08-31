const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
import { setStage2Result } from './chartread.js';
import { wizardState } from './state.js';
import { logger } from './logger.js';

// Module-level state: set by Stage 1 when it completes
let stage1Basename = "";
let stage1Cwd = "";
let currentManifest = null;
let discoveredPrinters = [];

let updateLabelPreviewFn = null;

/**
 * Called by targen.js (or app.js) after Stage 1 completes.
 * Passes the basename and working directory forward.
 */
export function setStage1Result(basename, cwd) {
  stage1Basename = basename || wizardState.basename;
  stage1Cwd = cwd || wizardState.cwd;
  wizardState.setTarget(stage1Basename, stage1Cwd);
  if (updateLabelPreviewFn) {
    updateLabelPreviewFn();
  }
}

export function initPrinttarg() {
  const instrumentSelect = document.getElementById("instrumentSelect");
  const pageSizeSelect = document.getElementById("pageSizeSelect");
  const customPageSizeRow = document.getElementById("customPageSizeRow");
  const customPageW = document.getElementById("customPageW");
  const customPageH = document.getElementById("customPageH");
  const bitDepthRadios = document.querySelectorAll('input[name="bitDepth"]');
  const tiffDpi = document.getElementById("tiffDpi");
  const printtargLayoutOrder = document.getElementById("printtargLayoutOrder");
  const printtargCustomSeedGroup = document.getElementById("printtargCustomSeedGroup");
  const printtargCustomSeed = document.getElementById("printtargCustomSeed");
  const btnCreateLayout = document.getElementById("btnCreateLayout");
  const logContainer = document.getElementById("printtargLogContainer");
  const logPre = document.getElementById("printtargLog");
  const tiffGallery = document.getElementById("tiffGallery");
  const galleryInfo = document.getElementById("galleryInfo");
  const galleryGrid = document.getElementById("galleryGrid");

  if (printtargLayoutOrder && printtargCustomSeedGroup) {
    printtargLayoutOrder.addEventListener("change", () => {
      if (printtargLayoutOrder.value === "custom_seed") {
        printtargCustomSeedGroup.classList.remove("hidden");
      } else {
        printtargCustomSeedGroup.classList.add("hidden");
      }
    });
  }

  // Target Label & Metadata elements (printtarg -d)
  const targetMetadataPrinter = document.getElementById("targetMetadataPrinter");
  const targetMetadataInkSet = document.getElementById("targetMetadataInkSet");
  const targetMetadataDriverPaper = document.getElementById("targetMetadataDriverPaper");
  const targetMetadataActualPaper = document.getElementById("targetMetadataActualPaper");
  const targetLabelPreview = document.getElementById("targetLabelPreview");
  const btnToggleLabelEdit = document.getElementById("btnToggleLabelEdit");

  let isManualLabelOverride = false;

  /**
   * Format current local date & time into standard DD/MM/YYYY HH:MM format.
   */
  function formatTimestamp(d = new Date()) {
    const pad = (n) => String(n).padStart(2, "0");
    const day = pad(d.getDate());
    const month = pad(d.getMonth() + 1);
    const year = d.getFullYear();
    const hours = pad(d.getHours());
    const mins = pad(d.getMinutes());
    return `${day}/${month}/${year} ${hours}:${mins}`;
  }

  /**
   * Assemble dynamic label string from Stage 1 run name and metadata inputs.
   */
  function assembleTargetLabel() {
    const parts = ["ICCery"];
    const runName = stage1Basename || wizardState.basename || "";
    if (runName.trim()) {
      parts.push(runName.trim());
    }

    const printer = targetMetadataPrinter ? targetMetadataPrinter.value.trim() : "";
    if (printer) parts.push(printer);

    const inkSet = targetMetadataInkSet ? targetMetadataInkSet.value.trim() : "";
    if (inkSet) parts.push(inkSet);

    const driverPaper = targetMetadataDriverPaper ? targetMetadataDriverPaper.value.trim() : "";
    if (driverPaper) parts.push(driverPaper);

    const actualPaper = targetMetadataActualPaper ? targetMetadataActualPaper.value.trim() : "";
    if (actualPaper) parts.push(actualPaper);

    parts.push(formatTimestamp());
    return parts.join(" - ");
  }

  function updateLabelPreview() {
    if (!targetLabelPreview) return;
    if (!isManualLabelOverride) {
      targetLabelPreview.value = assembleTargetLabel();
    }
  }
  updateLabelPreviewFn = updateLabelPreview;
  updateLabelPreview();

  // Bind input listeners for dynamic label assembly
  [targetMetadataPrinter, targetMetadataInkSet, targetMetadataDriverPaper, targetMetadataActualPaper].forEach(input => {
    if (input) {
      input.addEventListener("input", () => {
        updateLabelPreview();
      });
    }
  });

  // Toggle between auto-assembled preview and manual edit
  if (btnToggleLabelEdit && targetLabelPreview) {
    btnToggleLabelEdit.addEventListener("click", () => {
      isManualLabelOverride = !isManualLabelOverride;
      if (isManualLabelOverride) {
        targetLabelPreview.removeAttribute("readonly");
        targetLabelPreview.style.background = "var(--bg-color)";
        targetLabelPreview.style.borderColor = "var(--accent-color, #3b82f6)";
        btnToggleLabelEdit.textContent = "↺ Reset Auto";
        targetLabelPreview.focus();
      } else {
        targetLabelPreview.setAttribute("readonly", true);
        targetLabelPreview.style.background = "var(--bg-color)";
        targetLabelPreview.style.borderColor = "var(--border-color, #333)";
        btnToggleLabelEdit.textContent = "✏️ Edit Label";
        updateLabelPreview();
      }
    });
  }

  // Raw Printing UI elements
  const rawPrintPanel = document.getElementById("rawPrintPanel");
  const printerSelect = document.getElementById("printerSelect");
  const btnRefreshPrinters = document.getElementById("btnRefreshPrinters");
  const btnPrinterProperties = document.getElementById("btnPrinterProperties");
  const printerTraySelect = document.getElementById("printerTraySelect");
  const btnOrientPortrait = document.getElementById("btnOrientPortrait");
  const btnOrientLandscape = document.getElementById("btnOrientLandscape");
  const printerStatusBadge = document.getElementById("printerStatusBadge");
  const chkPpdFallback = document.getElementById("chkPpdFallback");
  const cupsOptionsGroup = document.getElementById("cupsOptionsGroup");
  const btnPrintAll = document.getElementById("btnPrintAll");
  const btnAdvanceToStage3 = document.getElementById("btnAdvanceToStage3");
  const printNotification = document.getElementById("printNotification");
  const printNotificationIcon = document.getElementById("printNotificationIcon");
  const printNotificationText = document.getElementById("printNotificationText");

  const isWindows = navigator.userAgent.includes("Windows") || (navigator.userAgentData && navigator.userAgentData.platform === "Windows");
  if (isWindows && cupsOptionsGroup) {
    cupsOptionsGroup.classList.add("hidden");
  }

  let selectedOrientation = "portrait";

  // Orientation toggle buttons
  if (btnOrientPortrait && btnOrientLandscape) {
    btnOrientPortrait.addEventListener("click", () => {
      selectedOrientation = "portrait";
      btnOrientPortrait.classList.add("active");
      btnOrientLandscape.classList.remove("active");
    });

    btnOrientLandscape.addEventListener("click", () => {
      selectedOrientation = "landscape";
      btnOrientLandscape.classList.add("active");
      btnOrientPortrait.classList.remove("active");
    });
  }

  // Show/hide custom page size inputs
  pageSizeSelect.addEventListener("change", (e) => {
    if (e.target.value === "custom") {
      customPageSizeRow.classList.remove("hidden");
    } else {
      customPageSizeRow.classList.add("hidden");
    }
  });

  /**
   * Display status feedback banners in the raw printing panel.
   */
  function showNotification(type, message) {
    if (!printNotification) return;
    printNotification.className = `notification-banner ${type}`;
    printNotification.classList.remove("hidden");

    if (printNotificationIcon) {
      if (type === "success") printNotificationIcon.textContent = "✓";
      else if (type === "error") printNotificationIcon.textContent = "✕";
      else printNotificationIcon.textContent = "ℹ️";
    }

    if (printNotificationText) {
      printNotificationText.textContent = message;
    }
  }

  function hideNotification() {
    if (printNotification) {
      printNotification.classList.add("hidden");
    }
  }

  /**
   * Fetch hardware trays and paper capabilities for selected printer.
   */
  async function loadPrinterCapabilities(printerName) {
    if (!printerTraySelect || !printerName) return;
    printerTraySelect.innerHTML = '<option value="" selected>Default / Auto Select</option>';

    try {
      const caps = await invoke("get_printer_capabilities", { printerName });
      if (caps && caps.trays && caps.trays.length > 0) {
        caps.trays.forEach(tray => {
          const opt = document.createElement("option");
          opt.value = tray.id;
          opt.textContent = tray.name;
          printerTraySelect.appendChild(opt);
        });
      }
    } catch (err) {
      console.warn("[ICCery Print] Could not fetch printer capabilities:", err);
    }
  }

  /**
   * Build current print options payload from UI controls.
   */
  function getSelectedPrintOptions() {
    const trayVal = printerTraySelect ? printerTraySelect.value : "";
    const paperSource = trayVal ? parseInt(trayVal, 10) : null;
    const ppdFallback = chkPpdFallback ? chkPpdFallback.checked : false;

    return {
      paper_source: paperSource,
      orientation: selectedOrientation,
      paper_size: pageSizeSelect ? pageSizeSelect.value : null,
      ppd_uncorrected_passthrough: ppdFallback,
    };
  }

  /**
   * Update the badge reflecting current printer's status.
   */
  function updatePrinterStatusBadge() {
    const selectedName = printerSelect.value;
    const printer = discoveredPrinters.find(p => p.name === selectedName);

    if (!printer || !printerStatusBadge) {
      if (printerStatusBadge) printerStatusBadge.classList.add("hidden");
      return;
    }

    printerStatusBadge.classList.remove("hidden", "badge-idle", "badge-ready", "badge-printing", "badge-stopped", "badge-error", "badge-default");

    const statusLower = (printer.status || "").toLowerCase();
    printerStatusBadge.textContent = printer.status || "Ready";

    if (statusLower.includes("print")) {
      printerStatusBadge.classList.add("badge-printing");
    } else if (statusLower.includes("stop") || statusLower.includes("disable") || statusLower.includes("error")) {
      printerStatusBadge.classList.add("badge-stopped");
    } else if (statusLower.includes("idle") || statusLower.includes("ready")) {
      printerStatusBadge.classList.add("badge-idle");
    } else {
      printerStatusBadge.classList.add("badge-default");
    }
  }

  /**
   * Discover and enumerate all OS-installed printers via Tauri IPC.
   */
  async function loadPrinters() {
    if (!printerSelect) return;
    printerSelect.disabled = true;
    printerSelect.innerHTML = '<option value="" disabled selected>Enumerating printers...</option>';
    if (printerStatusBadge) printerStatusBadge.classList.add("hidden");

    try {
      const printers = await invoke("get_printers");
      discoveredPrinters = Array.isArray(printers) ? printers : [];
      printerSelect.innerHTML = "";

      if (discoveredPrinters.length === 0) {
        printerSelect.innerHTML = '<option value="" disabled selected>No printers found</option>';
        printerSelect.disabled = true;
        if (btnPrintAll) btnPrintAll.disabled = true;
        return;
      }

      printerSelect.disabled = false;
      let defaultSelected = false;

      discoveredPrinters.forEach((p, idx) => {
        const opt = document.createElement("option");
        opt.value = p.name;
        opt.textContent = `${p.name}${p.is_default ? ' (Default)' : ''} [${p.status || 'Ready'}]`;
        if (p.is_default && !defaultSelected) {
          opt.selected = true;
          defaultSelected = true;
        }
        printerSelect.appendChild(opt);
      });

      if (!defaultSelected && discoveredPrinters.length > 0) {
        printerSelect.selectedIndex = 0;
      }

      const activePrinter = printerSelect.value;
      if (activePrinter) {
        loadPrinterCapabilities(activePrinter);
      }

      if (btnPrintAll && currentManifest) btnPrintAll.disabled = false;
      updatePrinterStatusBadge();

    } catch (err) {
      console.error("[ICCery Print] Failed to query printers:", err);
      printerSelect.innerHTML = `<option value="" disabled selected>Failed to load printers</option>`;
      printerSelect.disabled = true;
      if (btnPrintAll) btnPrintAll.disabled = true;
      showNotification("error", `Could not enumerate system printers: ${err}`);
    }
  }

  if (printerSelect) {
    printerSelect.addEventListener("change", () => {
      updatePrinterStatusBadge();
      loadPrinterCapabilities(printerSelect.value);
    });
  }

  if (btnRefreshPrinters) {
    btnRefreshPrinters.addEventListener("click", () => {
      loadPrinters();
    });
  }

  if (btnPrinterProperties) {
    btnPrinterProperties.addEventListener("click", async () => {
      const printerName = printerSelect ? printerSelect.value : "";
      if (!printerName) {
        showNotification("error", "Please select a destination printer first.");
        return;
      }

      try {
        showNotification("info", `Opening native printer preferences for '${printerName}'...`);
        await invoke("show_printer_properties", { printerName });
        showNotification("success", `✓ Printer driver preferences configured for '${printerName}'.`);
      } catch (err) {
        console.error("[ICCery Print] Failed to open printer properties:", err);
        showNotification("error", `Could not open printer properties: ${err}`);
      }
    });
  }

  // Load initial printer list on startup
  loadPrinters();

  // Create Layout button handler
  btnCreateLayout.addEventListener("click", async () => {
    // Validate that Stage 1 has been completed
    if (!stage1Basename) {
      logPre.textContent = "[ERROR] No .ti1 file available. Complete Stage 1 first.\n";
      logContainer.classList.remove("hidden");
      return;
    }

    logPre.textContent = "";
    logContainer.open = false;
    logContainer.classList.remove("hidden");
    tiffGallery.classList.add("hidden");
    if (rawPrintPanel) rawPrintPanel.classList.add("hidden");
    hideNotification();
    galleryGrid.innerHTML = "";
    btnCreateLayout.disabled = true;

    // Determine page size
    let pageSize = pageSizeSelect.value;
    if (pageSize === "custom") {
      const w = parseInt(customPageW.value, 10);
      const h = parseInt(customPageH.value, 10);
      if (!w || !h || w < 50 || h < 50) {
        logPre.textContent = "[ERROR] Custom page size must have width and height ≥ 50mm.\n";
        btnCreateLayout.disabled = false;
        return;
      }
      pageSize = `${w}x${h}`;
    }

    // Determine bit depth
    let bitDepth = 8;
    bitDepthRadios.forEach(radio => {
      if (radio.checked) bitDepth = parseInt(radio.value, 10);
    });

    const dpi = tiffDpi && tiffDpi.value ? parseInt(tiffDpi.value, 10) || 300 : 300;
    
    // Obtain custom label string
    let customLabel = null;
    if (targetLabelPreview && targetLabelPreview.value.trim()) {
      customLabel = targetLabelPreview.value.trim();
    }

    // Determine layout order & random seed
    let randomSeed = 1;
    let noRandomize = false;
    const layoutOrder = printtargLayoutOrder ? printtargLayoutOrder.value : "deterministic";
    if (layoutOrder === "raster") {
      noRandomize = true;
      randomSeed = null;
    } else if (layoutOrder === "custom_seed") {
      const parsedSeed = printtargCustomSeed ? parseInt(printtargCustomSeed.value, 10) : 1;
      randomSeed = isNaN(parsedSeed) || parsedSeed < 1 ? 1 : parsedSeed;
      noRandomize = false;
    } else {
      randomSeed = 1;
      noRandomize = false;
    }

    const config = {
      instrument: instrumentSelect.value,
      page_size: pageSize,
      bit_depth: bitDepth,
      dpi: dpi,
      custom_label: customLabel,
      random_seed: randomSeed,
      no_randomize: noRandomize,
      basename: stage1Basename,
      cwd: stage1Cwd,
    };

    const processId = `printtarg_${stage1Basename}`;
    let stdoutAccumulator = "";

    try {
      const unlistenStdout = await listen("process:stdout", (event) => {
        if (event.payload.id === processId && event.payload.line) {
          stdoutAccumulator += event.payload.line + "\n";
          logPre.textContent += event.payload.line + "\n";
          logPre.scrollTop = logPre.scrollHeight;
        }
      });

      const unlistenStderr = await listen("process:stderr", (event) => {
        if (event.payload.id === processId && event.payload.line) {
          logPre.textContent += "ERR: " + event.payload.line + "\n";
          logPre.scrollTop = logPre.scrollHeight;
        }
      });

      const unlistenExit = await listen("process:exit", (event) => {
        if (event.payload.id === processId) {
          unlistenStdout();
          unlistenStderr();
          unlistenExit();

          if (event.payload.code === 0) {
            logPre.textContent += "\n[SUCCESS] printtarg completed successfully.\n";
            btnCreateLayout.disabled = false;

            // Parse the JSON manifest from stdout
            const manifest = extractManifest(stdoutAccumulator);
            if (manifest && manifest.pages && manifest.pages.length > 0) {
              currentManifest = manifest;
              renderTiffGallery(manifest, config.cwd);
              if (rawPrintPanel) rawPrintPanel.classList.remove("hidden");
              if (discoveredPrinters.length > 0 && btnPrintAll) btnPrintAll.disabled = false;
              showNotification("info", "Target pages generated. Select your destination printer below and print with color management strictly bypassed.");
            }

            wizardState.setTarget(stage1Basename, stage1Cwd);
            setStage2Result(stage1Basename, stage1Cwd);
          } else {
            logPre.textContent += `\n[ERROR] printtarg exited with code ${event.payload.code}.\n`;
            btnCreateLayout.disabled = false;
          }
        }
      });

      logPre.textContent = "Starting printtarg...\n";
      await invoke("run_printtarg", { config });

    } catch (err) {
      logger.error(`run_printtarg invocation failed: ${err}`, 'Stage2-Printtarg');
      logPre.textContent += `\n[INVOKE ERROR] ${err}\n`;
      btnCreateLayout.disabled = false;
    }
  });

  /**
   * Spool a single TIFF target file with native color management bypass and options.
   */
  async function printTargetFile(filePath, label, triggeringButton) {
    const printerName = printerSelect ? printerSelect.value : "";
    if (!printerName) {
      showNotification("error", "Please select a destination printer first.");
      return;
    }

    const options = getSelectedPrintOptions();
    const origBtnContent = triggeringButton ? triggeringButton.innerHTML : "";

    if (triggeringButton) {
      triggeringButton.disabled = true;
      triggeringButton.innerHTML = '<span class="btn-spinner"></span> Spooling...';
    }

    showNotification("info", `Sending ${label} to '${printerName}' (bypassing color management)...`);

    try {
      await invoke("print_target_native", {
        printerName,
        tiffPath: filePath,
        options,
      });

      showNotification("success", `✓ Successfully spooled ${label} to '${printerName}' with raw color management bypass.`);
    } catch (err) {
      console.error("[ICCery Print Error]:", err);
      showNotification("error", `Print job failed for ${label}: ${err}`);
    } finally {
      if (triggeringButton) {
        triggeringButton.disabled = false;
        triggeringButton.innerHTML = origBtnContent;
      }
    }
  }

  /**
   * Print all generated TIFF target pages in sequence.
   */
  if (btnPrintAll) {
    btnPrintAll.addEventListener("click", async () => {
      if (!currentManifest || !currentManifest.pages || currentManifest.pages.length === 0) {
        showNotification("error", "No generated target pages available to print.");
        return;
      }

      const printerName = printerSelect ? printerSelect.value : "";
      if (!printerName) {
        showNotification("error", "Please select a destination printer first.");
        return;
      }

      const options = getSelectedPrintOptions();
      const cwd = stage1Cwd;
      const sep = cwd.includes('\\') ? '\\' : '/';
      const pages = currentManifest.pages;

      btnPrintAll.disabled = true;
      const btnText = btnPrintAll.querySelector(".btn-text");
      const btnSpinner = btnPrintAll.querySelector(".btn-spinner");
      if (btnSpinner) btnSpinner.classList.remove("hidden");
      if (btnText) btnText.textContent = "Spooling Targets...";

      let errorCount = 0;

      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        const filePath = cwd ? `${cwd}${sep}${page.filename}` : page.filename;
        showNotification("info", `Spooling page ${i + 1} of ${pages.length} (${page.filename}) to '${printerName}'...`);

        try {
          await invoke("print_target_native", {
            printerName,
            tiffPath: filePath,
            options,
          });
        } catch (err) {
          console.error(`[ICCery Print Error] Page ${page.filename}:`, err);
          showNotification("error", `Failed on page ${page.filename}: ${err}`);
          errorCount++;
          break;
        }
      }

      if (errorCount === 0) {
        showNotification("success", `✓ All ${pages.length} target page(s) successfully spooled to '${printerName}'!`);
      }

      btnPrintAll.disabled = false;
      if (btnSpinner) btnSpinner.classList.add("hidden");
      if (btnText) btnText.textContent = "🖨️ Print All Pages (Bypass CM)";
    });
  }

  // Proceed to Stage 3
  if (btnAdvanceToStage3) {
    btnAdvanceToStage3.addEventListener("click", () => {
      setStage2Result(stage1Basename, stage1Cwd);
      advanceToStage3();
    });
  }

  /**
   * Extract JSON manifest emitted by printtarg -u.
   */
  function extractManifest(stdout) {
    try {
      const match = stdout.match(/\{[\s\S]*?"event"\s*:\s*"manifest"[\s\S]*?\n\}/);
      if (match) {
        return JSON.parse(match[0]);
      }
      return null;
    } catch (e) {
      console.error("Failed to parse printtarg manifest JSON:", e);
      return null;
    }
  }

  /**
   * Render TIFF preview gallery with individual card print actions.
   */
  async function renderTiffGallery(manifest, cwd) {
    tiffGallery.classList.remove("hidden");

    const pageCount = manifest.pages.length;
    const totalPatches = manifest.pages.reduce((sum, p) => sum + p.patches, 0);
    const dims = manifest.pages[0];
    galleryInfo.textContent = `${pageCount} page(s) · ${totalPatches} patches · ${dims.width_mm} × ${dims.height_mm} mm per page`;
    galleryGrid.innerHTML = "";

    for (const page of manifest.pages) {
      const sep = cwd.includes('\\') ? '\\' : '/';
      const filePath = cwd ? `${cwd}${sep}${page.filename}` : page.filename;

      const card = document.createElement("div");
      card.className = "gallery-card";

      const label = document.createElement("div");
      label.className = "gallery-label";
      label.textContent = `${page.filename} (${page.patches} patches)`;
      card.appendChild(label);

      try {
        const pngBase64 = await invoke("read_tiff_preview_png", { path: filePath });
        const img = document.createElement("img");
        img.src = `data:image/png;base64,${pngBase64}`;
        img.alt = page.filename;
        img.onerror = () => {
          img.remove();
          const fallback = document.createElement("div");
          fallback.className = "gallery-fallback";
          fallback.innerHTML = `<span class="file-icon">📄</span><span>${page.filename}</span><span class="file-size">${page.patches} patches</span>`;
          card.insertBefore(fallback, label.nextSibling);
        };
        card.appendChild(img);
      } catch (err) {
        const fallback = document.createElement("div");
        fallback.className = "gallery-fallback";
        fallback.innerHTML = `<span class="file-icon">📄</span><span>${page.filename}</span><span class="file-size">Preview unavailable</span>`;
        card.appendChild(fallback);
      }

      // Individual Card Print Button
      const cardActions = document.createElement("div");
      cardActions.className = "gallery-card-actions";
      const btnPrintCard = document.createElement("button");
      btnPrintCard.type = "button";
      btnPrintCard.className = "btn-print-page";
      btnPrintCard.innerHTML = "<span>🖨️ Print Page</span>";
      btnPrintCard.addEventListener("click", () => {
        printTargetFile(filePath, page.filename, btnPrintCard);
      });
      cardActions.appendChild(btnPrintCard);
      card.appendChild(cardActions);

      galleryGrid.appendChild(card);
    }
  }
}

function advanceToStage3() {
  wizardState.navigateToStage(3);
}
