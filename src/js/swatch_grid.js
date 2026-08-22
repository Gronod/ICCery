import { computeDeltaE00 } from './delta_e.js';
import { labToCss, deviceRgbToCss } from './color_convert.js';

const { listen } = window.__TAURI__.event;

let unlistenJsonRow = null;

/**
 * Start listening for row events from a chartread process.
 * @param {string} processId - The process ID (e.g. "chartread_my_profile")
 */
export async function startSwatchListener(processId) {
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

    // Update progress bar
    const progress = ((data.row_index + 1) / data.total_rows) * 100;
    if (progressBar) progressBar.style.width = `${progress}%`;
    if (progressText) progressText.textContent = `Strip ${data.row_id} — ${data.row_index + 1} / ${data.total_rows}`;

    // Create row container
    const rowEl = document.createElement("div");
    rowEl.className = "swatch-row";

    const rowLabel = document.createElement("div");
    rowLabel.className = "swatch-row-label";
    rowLabel.textContent = data.row_id;
    rowEl.appendChild(rowLabel);

    const rowPatches = document.createElement("div");
    rowPatches.className = "swatch-row-patches";

    for (const patch of data.patches) {
      if (patch.is_pad) continue; // Skip spacer patches

      const patchEl = document.createElement("div");
      patchEl.className = "swatch-patch";

      // Determine the display colour
      let bgColor;
      if (patch.measured && patch.measured.Lab) {
        bgColor = labToCss(patch.measured.Lab);
      } else if (patch.device && patch.device.length === 3) {
        bgColor = deviceRgbToCss(patch.device);
      } else {
        bgColor = "#888";
      }

      const swatch = document.createElement("div");
      swatch.className = "swatch-color";
      swatch.style.backgroundColor = bgColor;
      patchEl.appendChild(swatch);

      // Compute and display ΔE₀₀ if both expected and measured Lab are present
      if (patch.expected && patch.expected.Lab && patch.measured && patch.measured.Lab) {
        const deltaE = computeDeltaE00(patch.expected.Lab, patch.measured.Lab);

        const deLabel = document.createElement("div");
        deLabel.className = "swatch-de";
        deLabel.textContent = deltaE.toFixed(1);

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

      patchEl.title = `${patch.loc} (ID: ${patch.id})`;
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
