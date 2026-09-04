import { computeDeltaE00 } from './delta_e.js';
import { labToCss, deviceRgbToCss, deviceCmykToCss } from './color_convert.js';

const { listen, emit } = window.__TAURI__.event;
const { invoke } = window.__TAURI__.core;

let unlistenJsonRow = null;

// Cached ΔE thresholds; refreshed from settings on load and when settings change.
let deltaEThresholds = { goodMax: 2.0, warnMax: 5.0 };

/**
 * Load the ΔE traffic-light thresholds from persisted app settings.
 * Falls back to 2.0 / 5.0 if settings are missing or malformed.
 */
async function refreshDeltaEThresholds() {
  try {
    const s = await invoke('load_settings');
    deltaEThresholds = {
      goodMax: s.delta_e_good_max ?? 2.0,
      warnMax: s.delta_e_warning_max ?? 5.0,
    };
    // Enforce the invariant at runtime in case a user hand-edited settings.json.
    if (deltaEThresholds.goodMax > deltaEThresholds.warnMax) {
      console.warn('ΔE thresholds invalid (good > warning); resetting to defaults.');
      deltaEThresholds = { goodMax: 2.0, warnMax: 5.0 };
    }
  } catch (err) {
    console.warn('Could not load ΔE thresholds, using defaults:', err);
    deltaEThresholds = { goodMax: 2.0, warnMax: 5.0 };
  }
}

/**
 * Classify a CIEDE2000 value using the current thresholds.
 * @param {number} deltaE
 * @returns {{ label: string, cssClass: string }}
 */
function classifyDeltaE(deltaE) {
  if (deltaE < deltaEThresholds.goodMax) {
    return { label: "Good", cssClass: "de-good" };
  } else if (deltaE < deltaEThresholds.warnMax) {
    return { label: "Warning", cssClass: "de-warning" };
  } else {
    return { label: "Bad", cssClass: "de-bad" };
  }
}

/**
 * Re-classify all already-rendered swatches using the current thresholds.
 * Call this after the user changes thresholds in Settings.
 */
function reclassifySwatches() {
  document.querySelectorAll('.swatch-patch[data-delta-e]').forEach((patchEl) => {
    const deltaE = parseFloat(patchEl.dataset.deltaE);
    if (Number.isNaN(deltaE)) return;

    patchEl.classList.remove('de-good', 'de-warning', 'de-bad');
    const { cssClass, label } = classifyDeltaE(deltaE);
    patchEl.classList.add(cssClass);

    // Update the classification word in the title without re-parsing everything.
    if (patchEl.title) {
      patchEl.title = patchEl.title.replace(/\s*\([^)]*\)$/, '') + ` (${label})`;
    }
  });
}

// Listen for the custom event emitted by settings.js after a successful save.
window.addEventListener('settings-saved', () => {
  refreshDeltaEThresholds().then(reclassifySwatches);
});

/**
 * Start listening for row events from a chartread process.
 * @param {string} processId - The process ID (e.g. "chartread_my_profile")
 * @param {Function} [onRowComplete] - Optional callback invoked on each completed row
 */
export async function startSwatchListener(processId, onRowComplete) {
  const grid = document.getElementById("swatchGrid");
  const progressBar = document.getElementById("readProgress");
  const progressText = document.getElementById("readProgressText");
  const statsPanel = document.getElementById("readStats");

  // Load thresholds at listener start
  await refreshDeltaEThresholds();

  // Clear previous state
  grid.innerHTML = "";
  let totalPatches = 0;
  let totalDeltaE = 0;
  let patchCount = 0;
  let maxDeltaE = 0;

  unlistenJsonRow = await listen("process:json_row", (event) => {
    if (event.payload.id !== processId) return;

    let data;
    try {
      data = JSON.parse(event.payload.json);
    } catch (e) {
      console.error("Failed to parse json_row:", e);
      return;
    }

    if (data.event !== "row_complete") return;

    if (onRowComplete && typeof onRowComplete === "function") {
      onRowComplete({
        rowIndex: data.row_index,
        totalRows: data.total_rows,
        rowId: data.row_id,
        isAllComplete: data.row_index + 1 >= data.total_rows,
      });
    }

    // Update progress bar
    const progress = ((data.row_index + 1) / data.total_rows) * 100;
    if (progressBar) progressBar.style.width = `${progress}%`;
    if (progressText) progressText.textContent = `Strip ${data.row_id} — ${data.row_index + 1} / ${data.total_rows}`;

    // Create row container
    // Row and patch order from chartread (A->Z, 1->N) is rendered
    // left-to-right / top-to-bottom to match the printtarg output.
    const rowEl = document.createElement("div");
    rowEl.className = "swatch-row";

    const rowLabel = document.createElement("div");
    rowLabel.className = "swatch-row-label";
    rowLabel.textContent = data.row_id;
    rowEl.appendChild(rowLabel);

    const rowPatches = document.createElement("div");
    rowPatches.className = "swatch-row-patches";

    for (const patch of data.patches) {
      // Argyll marks spacer/boundary patches with is_pad. Some printtarg
      // layouts also flag white reference patches (-e white steps) as pads,
      // but those carry valid expected or measured device data. Only skip
      // pads that have no measurement and no non-zero device coordinates.
      if (patch.is_pad && !patch.measured && (!patch.device || patch.device.every(v => v === 0))) continue;

      const patchEl = document.createElement("div");
      patchEl.className = "swatch-patch";

      let intendedCss = "#888";
      if (patch.expected && patch.expected.Lab) {
        intendedCss = labToCss(patch.expected.Lab);
      } else if (patch.device && patch.device.length === 3) {
        intendedCss = deviceRgbToCss(patch.device);
      } else if (patch.device && patch.device.length === 4) {
        intendedCss = deviceCmykToCss(patch.device);
      }

      let measuredCss = null;
      if (patch.measured && patch.measured.Lab) {
        measuredCss = labToCss(patch.measured.Lab);
      }

      const swatch = document.createElement("div");
      swatch.className = "swatch-color";

      if (measuredCss) {
        swatch.style.background = `linear-gradient(135deg, ${intendedCss} 50%, ${measuredCss} 50%)`;
      } else {
        swatch.style.backgroundColor = intendedCss;
      }

      patchEl.appendChild(swatch);

      // Build a structured tooltip for the patch
      let titleStr = `${patch.loc} (ID: ${patch.id})`;
      if (patch.expected && patch.expected.Lab) {
        titleStr += `\nIntended Lab: ${patch.expected.Lab.map(v => v.toFixed(1)).join(', ')}`;
      } else if (patch.device) {
        titleStr += `\nIntended Device: ${patch.device.map(v => v.toFixed(1)).join(', ')}`;
      }

      if (patch.measured && patch.measured.Lab) {
        titleStr += `\nMeasured Lab: ${patch.measured.Lab.map(v => v.toFixed(1)).join(', ')}`;
      }

      // Compute and display ΔE₀₀ if both expected and measured Lab are present
      if (patch.expected && patch.expected.Lab && patch.measured && patch.measured.Lab) {
        const deltaE = computeDeltaE00(patch.expected.Lab, patch.measured.Lab);
        const { label, cssClass } = classifyDeltaE(deltaE);

        // Persist the raw ΔE on the element so re-classification works after
        // the user changes thresholds in Settings.
        patchEl.dataset.deltaE = deltaE.toFixed(4);

        const deLabel = document.createElement("div");
        deLabel.className = "swatch-de";
        deLabel.textContent = deltaE.toFixed(1);

        titleStr += `\nΔE₀₀: ${deltaE.toFixed(2)} (${label})`;

        patchEl.classList.add(cssClass);
        patchEl.appendChild(deLabel);

        // Accumulate stats
        totalDeltaE += deltaE;
        patchCount++;
        if (deltaE > maxDeltaE) maxDeltaE = deltaE;
      }

      patchEl.title = titleStr;
      rowPatches.appendChild(patchEl);
    }

    rowEl.appendChild(rowPatches);
    grid.appendChild(rowEl);

    // Scroll to bottom
    grid.scrollTop = grid.scrollHeight;

    // Update stats
    if (statsPanel && patchCount > 0) {
      const avgDe = (totalDeltaE / patchCount).toFixed(2);
      statsPanel.textContent = `Avg ΔE₀₀: ${avgDe} · Max ΔE₀₀: ${maxDeltaE.toFixed(2)} · Patches: ${patchCount}`;
    }
  });
}

/**
 * Stop listening for row events.
 */
export function stopSwatchListener() {
  if (unlistenJsonRow) {
    unlistenJsonRow();
    unlistenJsonRow = null;
  }
}
