import { computeDeltaE00 } from './delta_e.js';
import { labToCss, deviceRgbToCss, deviceCmykToCss } from './color_convert.js';

const { listen } = window.__TAURI__.event;

let unlistenJsonRow = null;

/**
 * Traffic-light classification for a CIEDE2000 value using default
 * tolerance bands. These defaults are overridden by user settings when
 * configured (see feat/184-configurable-delta-e).
 * @param {number} deltaE
 * @returns {string} "Good" | "Warning" | "Bad"
 */
function classifyDeltaE(deltaE) {
  if (deltaE < 2) return "Good";
  if (deltaE < 5) return "Warning";
  return "Bad";
}

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
    // Row and patch order from chartread (A->Z, 1->N) matches the physical
    // left-to-right / top-to-bottom layout produced by printtarg.
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
        const classification = classifyDeltaE(deltaE);

        const deLabel = document.createElement("div");
        deLabel.className = "swatch-de";
        deLabel.textContent = deltaE.toFixed(1);

        titleStr += `\nΔE₀₀: ${deltaE.toFixed(2)} (${classification})`;

        // Traffic light classification
        if (deltaE < 2) {
          patchEl.classList.add("de-good");       // Green
        } else if (deltaE < 5) {
          patchEl.classList.add("de-warning");     // Amber
        } else {
          patchEl.classList.add("de-bad");          // Red
        }

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
