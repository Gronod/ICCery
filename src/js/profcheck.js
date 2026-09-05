const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
import { loadGamutMesh } from './gamut_viewer.js';
import { wizardState } from './state.js';
import { logger } from './logger.js';

let profileBasename = "";
let profileCwd = "";

/**
 * Called by colprof.js after Stage 4 completes.
 */
export function setStage4Result(basename, cwd) {
  profileBasename = basename || wizardState.basename;
  profileCwd = cwd || wizardState.cwd;
  wizardState.setTarget(profileBasename, profileCwd);
  loadVerificationHistory();
}

/**
 * Parse profcheck output for Average, Peak, and RMS delta-E values and patch count.
 * Supports Argyll's -u JSON summary object, text summary line, and legacy plain-text output.
 * @param {string} stdout - Full profcheck stdout.
 * @returns {{ avgDe: number, maxDe: number, rmsDe: number, patchCount: number, warnings: string[] }}
 */
export function parseProfcheckReport(stdout) {
  let avgDe = 0.0;
  let maxDe = 0.0;
  let rmsDe = 0.0;
  let patchCount = 0;
  const warnings = [];

  if (!stdout || typeof stdout !== 'string') {
    return { avgDe, maxDe, rmsDe, patchCount, warnings: ['No stdout received from profcheck.'] };
  }

  // Parse patch count from "No of test patches = (\d+)"
  const patchMatch = stdout.match(/No\s+of\s+test\s+patches\s*=\s*(\d+)/i);
  if (patchMatch) {
    patchCount = parseInt(patchMatch[1], 10);
  }

  // Argyll's JSON output can appear either as a compact object on a single
  // line or embedded inside larger text. Accept objects with event === "report"
  // or containing any of avg_de, avg_de2000, peak_de, peak_de2000, rms, rms_de.
  const jsonObjects = [];
  const re = /\{[\s\S]*?\}/g;
  let m;
  while ((m = re.exec(stdout)) !== null) {
    try {
      const parsed = JSON.parse(m[0]);
      if (typeof parsed === 'object' && parsed !== null) {
        if (
          parsed.event === 'report' ||
          'avg_de' in parsed ||
          'avg_de2000' in parsed ||
          'peak_de' in parsed ||
          'peak_de2000' in parsed ||
          'rms' in parsed ||
          'rms_de' in parsed
        ) {
          jsonObjects.push(parsed);
        }
      }
    } catch (e) {
      // Not a valid JSON object, ignore.
    }
  }

  if (jsonObjects.length > 0) {
    // When several report objects exist (de2000, de94, de), prefer *de2000 object matching -k
    const de2000Obj = jsonObjects.find(o => 'avg_de2000' in o || 'peak_de2000' in o);
    const targetJson = de2000Obj || jsonObjects[jsonObjects.length - 1];

    avgDe = typeof targetJson.avg_de2000 === 'number' ? targetJson.avg_de2000 :
            (typeof targetJson.avg_de === 'number' ? targetJson.avg_de : 0);
    maxDe = typeof targetJson.peak_de2000 === 'number' ? targetJson.peak_de2000 :
            (typeof targetJson.max_de === 'number' ? targetJson.max_de :
            (typeof targetJson.peak_de === 'number' ? targetJson.peak_de : 0));
    rmsDe = typeof targetJson.rms === 'number' ? targetJson.rms :
            (typeof targetJson.rms_de === 'number' ? targetJson.rms_de : 0);
  } else {
    // Check for standard Argyll text summary line:
    // Profile check complete, errors...: max. = %f, avg. = %f, RMS = %f
    const summaryMatch = stdout.match(/Profile check complete,\s*errors[^\:]*:\s*max\.\s*=\s*([\d\.]+),\s*avg\.\s*=\s*([\d\.]+),\s*RMS\s*=\s*([\d\.]+)/i);
    if (summaryMatch) {
      maxDe = parseFloat(summaryMatch[1]);
      avgDe = parseFloat(summaryMatch[2]);
      rmsDe = parseFloat(summaryMatch[3]);
    } else {
      // Regex fallbacks for standard profcheck text output
      const avgPatterns = [
        /avg(?:\.?|erage)\s*(?:dE\s*)?[:=]\s*([\d\.]+)/i,
        /average\s+(?:dE\s*)?([\d\.]+)/i,
        /mean\s+(?:dE\s*)?([\d\.]+)/i,
        /dE\s+average[^\d]*([\d\.]+)/i,
      ];
      const maxPatterns = [
        /max(?:\.?|imum)\s*(?:dE\s*)?[:=]\s*([\d\.]+)/i,
        /peak\s*(?:dE\s*)?[:=]\s*([\d\.]+)/i,
        /worst\s*(?:dE\s*)?([\d\.]+)/i,
        /dE\s+max[^\d]*([\d\.]+)/i,
      ];
      const rmsPatterns = [
        /RMS(?:\.?)\s*(?:dE\s*)?[:=]\s*([\d\.]+)/i,
        /rms(?:\.?)\s*(?:dE\s*)?([\d\.]+)/i,
        /root\s+mean\s+sq(?:uare)?\s*(?:dE\s*)?([\d\.]+)/i,
      ];

      const find = (patterns) => {
        for (const p of patterns) {
          const match = stdout.match(p);
          if (match) return match;
        }
        return null;
      };

      const avgMatch = find(avgPatterns);
      const maxMatch = find(maxPatterns);
      const rmsMatch = find(rmsPatterns);

      if (avgMatch) avgDe = parseFloat(avgMatch[1]);
      else warnings.push('Could not detect Average ΔE in profcheck output.');

      if (maxMatch) maxDe = parseFloat(maxMatch[1]);
      else warnings.push('Could not detect Peak ΔE in profcheck output.');

      if (rmsMatch) rmsDe = parseFloat(rmsMatch[1]);
      else warnings.push('Could not detect RMS ΔE in profcheck output.');

      if (!avgMatch && !maxMatch && !rmsMatch) {
        warnings.push('No delta-E values were found in profcheck output.');
      }
    }
  }

  return { avgDe, maxDe, rmsDe, patchCount, warnings };
}

/**
 * Checks for a printer drift breach condition:
 * Returns an alert string if the last >=2 consecutive records have avg_de >= 3.5
 * and span distinct calendar dates (or are >= 1 hour apart).
 * @param {Array<object>} records - Array of verification records sorted ascending by timestamp.
 * @returns {string|null} Alert text or null if no breach.
 */
export function checkBreachAlert(records) {
  if (!records || records.length < 2) return null;

  let count = 0;
  let firstBreach = null;
  let latestBreach = null;

  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].avg_de >= 3.5) {
      count++;
      if (!latestBreach) latestBreach = records[i];
      firstBreach = records[i];
    } else {
      break;
    }
  }

  if (count >= 2 && firstBreach && latestBreach) {
    const tFirst = new Date(firstBreach.timestamp).getTime();
    const tLatest = new Date(latestBreach.timestamp).getTime();
    const diffHours = (tLatest - tFirst) / (1000 * 60 * 60);
    const dFirst = firstBreach.timestamp.slice(0, 10);
    const dLatest = latestBreach.timestamp.slice(0, 10);

    if (dFirst !== dLatest || diffHours >= 1.0) {
      const fmt = (ts) => {
        try {
          return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        } catch (_) {
          return ts;
        }
      };
      return `⚠️ Re-profiling Recommended — ${count} consecutive verifications out of tolerance (first: ${fmt(firstBreach.timestamp)}, latest: ${fmt(latestBreach.timestamp)})`;
    }
  }

  return null;
}

/**
 * Loads verification history records and updates the Stage 5 drift analytics UI.
 */
export async function loadVerificationHistory(selectedPrinter = "") {
  const profileName = profileBasename || wizardState.basename || "";
  const driftSection = document.getElementById("driftHistorySection");
  if (!driftSection) return;

  const alertCard = document.getElementById("driftAlertCard");
  const alertText = document.getElementById("driftAlertText");
  const emptyState = document.getElementById("driftEmptyState");
  const chartWrap = document.getElementById("driftChartWrap");
  const chartSvg = document.getElementById("driftTrendChart");
  const tbody = document.getElementById("verificationHistoryTbody");
  const btnExport = document.getElementById("btnExportHistoryCsv");
  const btnClear = document.getElementById("btnClearHistory");
  const printerFilterSelect = document.getElementById("driftPrinterFilter");
  const filterRow = document.getElementById("driftFilterRow");

  try {
    // 1. Fetch all records for current profile to populate printer options
    const allProfileRecords = await invoke("get_verification_history", {
      profileName: profileName || null,
      printerName: null,
    });

    if (printerFilterSelect) {
      const distinctPrinters = Array.from(new Set(allProfileRecords.map(r => r.printer_name).filter(Boolean)));
      printerFilterSelect.innerHTML = `<option value="">All Printers</option>`;
      distinctPrinters.forEach(p => {
        const opt = document.createElement("option");
        opt.value = p;
        opt.textContent = p;
        if (p === selectedPrinter) opt.selected = true;
        printerFilterSelect.appendChild(opt);
      });
      if (filterRow) {
        filterRow.classList.toggle("hidden", distinctPrinters.length <= 1);
      }
    }

    // 2. Fetch filtered records
    const records = await invoke("get_verification_history", {
      profileName: profileName || null,
      printerName: selectedPrinter || null,
    });

    // 3. Breach Alert check (evaluated against profile records chronologically)
    const breachMessage = checkBreachAlert(records);
    if (alertCard && alertText) {
      if (breachMessage) {
        alertText.textContent = breachMessage;
        alertCard.classList.remove("hidden");
      } else {
        alertCard.classList.add("hidden");
      }
    }

    const hasRecords = records.length > 0;
    if (btnExport) btnExport.disabled = !hasRecords;
    if (btnClear) btnClear.disabled = allProfileRecords.length === 0;

    if (!hasRecords) {
      if (emptyState) emptyState.classList.remove("hidden");
      if (chartWrap) chartWrap.classList.add("hidden");
      if (tbody) tbody.innerHTML = "";
      return;
    }

    if (emptyState) emptyState.classList.add("hidden");
    if (chartWrap) chartWrap.classList.remove("hidden");

    // 4. Render Hand-rolled SVG Trend Chart
    if (chartSvg) {
      renderDriftTrendChart(chartSvg, records);
    }

    // 5. Render Run-Log Table (newest first)
    if (tbody) {
      tbody.innerHTML = "";
      const reversed = [...records].reverse();
      reversed.forEach(r => {
        const tr = document.createElement("tr");

        const tdDate = document.createElement("td");
        try {
          tdDate.textContent = new Date(r.timestamp).toLocaleString();
        } catch (_) {
          tdDate.textContent = r.timestamp;
        }

        const tdPrinter = document.createElement("td");
        tdPrinter.textContent = r.printer_name || "Unknown";

        const tdAvg = document.createElement("td");
        tdAvg.textContent = r.avg_de.toFixed(2);

        const tdMax = document.createElement("td");
        tdMax.textContent = r.max_de.toFixed(2);

        const tdRms = document.createElement("td");
        tdRms.textContent = r.rms_de.toFixed(2);

        const tdPatches = document.createElement("td");
        tdPatches.textContent = r.patch_count || "-";

        const tdStatus = document.createElement("td");
        const badge = document.createElement("span");
        const statusClass = r.status === 'excellent' ? 'badge-excellent' :
                            r.status === 'good' ? 'badge-good' :
                            r.status === 'acceptable' ? 'badge-acceptable' : 'badge-poor';
        badge.className = `status-badge ${statusClass}`;
        badge.textContent = r.status ? r.status.toUpperCase() : "UNKNOWN";
        tdStatus.appendChild(badge);

        tr.appendChild(tdDate);
        tr.appendChild(tdPrinter);
        tr.appendChild(tdAvg);
        tr.appendChild(tdMax);
        tr.appendChild(tdRms);
        tr.appendChild(tdPatches);
        tr.appendChild(tdStatus);

        tbody.appendChild(tr);
      });
    }
  } catch (e) {
    logger.warn(`Failed to load verification history: ${e}`, 'Stage5-Profcheck');
  }
}

/**
 * Hand-rolled SVG line chart rendering verification drift trends with ICCery threshold bands.
 */
function renderDriftTrendChart(svg, records) {
  // Downsample to the last 50 points if necessary
  const data = records.length > 50 ? records.slice(records.length - 50) : records;

  const width = 640;
  const height = 220;
  const padLeft = 45;
  const padRight = 30;
  const padTop = 20;
  const padBottom = 28;

  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  // Compute max Y (minimum 4.0 for all threshold bands)
  let maxY = 4.0;
  data.forEach(d => {
    if (d.max_de > maxY) maxY = d.max_de;
    if (d.avg_de > maxY) maxY = d.avg_de;
  });
  maxY = Math.ceil(maxY * 1.1);

  const getY = (val) => padTop + plotH - (val / maxY) * plotH;
  const getX = (idx) => {
    if (data.length <= 1) return padLeft + plotW / 2;
    return padLeft + (idx / (data.length - 1)) * plotW;
  };

  let elements = [];

  // Threshold background bands
  // Bands at: 0-1.0 (Excellent), 1.0-2.0 (Good), 2.0-3.5 (Acceptable), 3.5-maxY (Warning)
  const bands = [
    { from: 0.0, to: 1.0, color: "rgba(34, 197, 94, 0.08)", label: "Excellent (< 1.0)" },
    { from: 1.0, to: 2.0, color: "rgba(59, 130, 246, 0.08)", label: "Good (< 2.0)" },
    { from: 2.0, to: 3.5, color: "rgba(245, 158, 11, 0.08)", label: "Acceptable (< 3.5)" },
    { from: 3.5, to: maxY, color: "rgba(239, 68, 68, 0.08)", label: "Warning (≥ 3.5)" },
  ];

  bands.forEach(b => {
    const yTop = getY(Math.min(b.to, maxY));
    const yBot = getY(b.from);
    const bandH = Math.max(0, yBot - yTop);
    elements.push(`<rect x="${padLeft}" y="${yTop}" width="${plotW}" height="${bandH}" fill="${b.color}" />`);
  });

  // Threshold lines
  [1.0, 2.0, 3.5].forEach(thresh => {
    if (thresh <= maxY) {
      const y = getY(thresh);
      elements.push(`<line x1="${padLeft}" y1="${y}" x2="${padLeft + plotW}" y2="${y}" stroke="rgba(255,255,255,0.15)" stroke-dasharray="3,3" />`);
      elements.push(`<text x="${padLeft + plotW - 4}" y="${y - 3}" class="drift-band-label">${thresh.toFixed(1)} ΔE</text>`);
    }
  });

  // Verification bands caption
  elements.push(`<text x="${padLeft + 6}" y="${padTop + 12}" fill="rgba(255,255,255,0.35)" font-size="9px" font-family="sans-serif">ICCery verification bands</text>`);

  // Y Axis ticks
  const ySteps = [0, 1, 2, 3.5];
  if (maxY > 5) ySteps.push(Math.floor(maxY));
  ySteps.forEach(val => {
    const y = getY(val);
    elements.push(`<line x1="${padLeft - 4}" y1="${y}" x2="${padLeft}" y2="${y}" stroke="rgba(255,255,255,0.3)" />`);
    elements.push(`<text x="${padLeft - 8}" y="${y + 3}" text-anchor="end" class="drift-chart-text">${val.toFixed(1)}</text>`);
  });

  // X Axis baseline
  elements.push(`<line x1="${padLeft}" y1="${padTop + plotH}" x2="${padLeft + plotW}" y2="${padTop + plotH}" stroke="rgba(255,255,255,0.3)" />`);

  // Series points & paths
  if (data.length === 1) {
    const x = getX(0);
    const yAvg = getY(data[0].avg_de);
    const yMax = getY(data[0].max_de);

    // Dashed horizontal line across plot for single point
    elements.push(`<line x1="${padLeft}" y1="${yAvg}" x2="${padLeft + plotW}" y2="${yAvg}" stroke="#3b82f6" stroke-dasharray="4,4" stroke-opacity="0.5" />`);
    elements.push(`<circle cx="${x}" cy="${yAvg}" r="5" class="drift-dot-avg"><title>Avg ΔE: ${data[0].avg_de.toFixed(2)} (${data[0].timestamp})</title></circle>`);
    elements.push(`<circle cx="${x}" cy="${yMax}" r="4" class="drift-dot-max"><title>Peak ΔE: ${data[0].max_de.toFixed(2)}</title></circle>`);
  } else {
    // Polylines
    let ptsAvg = [];
    let ptsMax = [];
    data.forEach((d, idx) => {
      const x = getX(idx);
      const yA = getY(d.avg_de);
      const yM = getY(d.max_de);
      ptsAvg.push(`${x.toFixed(1)},${yA.toFixed(1)}`);
      ptsMax.push(`${x.toFixed(1)},${yM.toFixed(1)}`);
    });

    elements.push(`<polyline points="${ptsMax.join(' ')}" class="drift-line-max" />`);
    elements.push(`<polyline points="${ptsAvg.join(' ')}" class="drift-line-avg" />`);

    // Draw dots
    data.forEach((d, idx) => {
      const x = getX(idx);
      const yA = getY(d.avg_de);
      const yM = getY(d.max_de);
      const dateStr = d.timestamp.slice(0, 10);
      elements.push(`<circle cx="${x.toFixed(1)}" cy="${yA.toFixed(1)}" r="4" class="drift-dot-avg"><title>Avg: ${d.avg_de.toFixed(2)} (${dateStr})</title></circle>`);
      elements.push(`<circle cx="${x.toFixed(1)}" cy="${yM.toFixed(1)}" r="3" class="drift-dot-max"><title>Peak: ${d.max_de.toFixed(2)} (${dateStr})</title></circle>`);
    });

    // Start and End date labels on X axis
    const startStr = data[0].timestamp.slice(5, 10);
    const endStr = data[data.length - 1].timestamp.slice(5, 10);
    elements.push(`<text x="${padLeft}" y="${height - 8}" text-anchor="start" class="drift-chart-text">${startStr}</text>`);
    elements.push(`<text x="${padLeft + plotW}" y="${height - 8}" text-anchor="end" class="drift-chart-text">${endStr}</text>`);
  }

  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = elements.join("\n");
}

export function initProfcheck() {
  const btnVerify = document.getElementById("btnVerify");
  const logContainer = document.getElementById("profcheckLogContainer");
  const logPre = document.getElementById("profcheckLog");
  const reportCard = document.getElementById("profcheckReportCard");
  const avgDeEl = document.getElementById("profcheckAvgDe");
  const maxDeEl = document.getElementById("profcheckMaxDe");
  const rmsDeEl = document.getElementById("profcheckRmsDe");
  const badgeEl = document.getElementById("profcheckBadge");
  const btnExport = document.getElementById("btnExportHistoryCsv");
  const btnClear = document.getElementById("btnClearHistory");
  const printerFilterSelect = document.getElementById("driftPrinterFilter");

  if (!btnVerify) return;

  // Listen for printer filter changes in drift history
  if (printerFilterSelect) {
    printerFilterSelect.addEventListener("change", () => {
      loadVerificationHistory(printerFilterSelect.value);
    });
  }

  // Export CSV button handler
  if (btnExport) {
    btnExport.addEventListener("click", async () => {
      try {
        const profileName = profileBasename || wizardState.basename || "verification";
        const defaultName = `${profileName}_history.csv`;
        const chosenPath = await invoke("select_csv_save_path", { defaultName });
        if (chosenPath) {
          const printerFilter = printerFilterSelect ? printerFilterSelect.value : "";
          const count = await invoke("export_verification_history_csv", {
            destPath: chosenPath,
            profileName: profileName || null,
            printerName: printerFilter || null,
          });
          wizardState.showNotice(`✓ Exported ${count} verification records to ${chosenPath}`, "success");
        }
      } catch (err) {
        logger.error(`CSV Export failed: ${err}`, 'Stage5-Profcheck');
        wizardState.showNotice(`Failed to export CSV: ${err}`, "error");
      }
    });
  }

  // Clear History button handler
  if (btnClear) {
    btnClear.addEventListener("click", async () => {
      if (confirm("Are you sure you want to clear all verification history records? This cannot be undone.")) {
        try {
          await invoke("clear_verification_history");
          await loadVerificationHistory();
          wizardState.showNotice("Verification history cleared.", "info");
        } catch (err) {
          logger.error(`Clear history failed: ${err}`, 'Stage5-Profcheck');
          wizardState.showNotice(`Failed to clear history: ${err}`, "error");
        }
      }
    });
  }

  // Listen for Stage 5 navigation to load history
  window.addEventListener("stage-changed", (event) => {
    if (event.detail && event.detail.stage === 5) {
      loadVerificationHistory();
    }
  });

  // Initial load
  loadVerificationHistory();

  btnVerify.addEventListener("click", async () => {
    const basename = profileBasename || wizardState.basename;
    const cwd = profileCwd || wizardState.cwd;

    if (!basename || !cwd) {
      logPre.textContent = "[ERROR] No profile available to verify. Please complete Stage 4 first.\n";
      logContainer.open = true;
      logContainer.classList.remove("hidden");
      btnVerify.disabled = false;
      return;
    }

    profileBasename = basename;
    profileCwd = cwd;

    const sep = cwd.includes('\\') ? '\\' : '/';
    const ti3Path = cwd ? `${cwd}${sep}${basename}.ti3` : `${basename}.ti3`;

    // Query platform-aware profile path (.icm on Windows, .icc on Unix)
    let iccPath = cwd ? `${cwd}${sep}${basename}.icc` : `${basename}.icc`;
    try {
      iccPath = await invoke("get_profile_path", { cwd, basename });
    } catch (e) {
      console.warn("Could not query platform profile path:", e);
    }

    logPre.textContent = "";
    logContainer.open = false;
    logContainer.classList.remove("hidden");
    reportCard.classList.add("hidden");
    btnVerify.disabled = true;

    const config = {
      ti3_path: ti3Path,
      icc_path: iccPath,
      cwd: cwd,
    };

    const processId = `profcheck_${ti3Path}`;
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

      const unlistenExit = await listen("process:exit", async (event) => {
        if (event.payload.id === processId) {
          unlistenStdout();
          unlistenStderr();
          unlistenExit();
          btnVerify.disabled = false;

          if (event.payload.code === 0) {
            logPre.textContent += "\n[SUCCESS] profcheck verification finished.\n";
            const report = parseProfcheckReport(stdoutAccumulator);

            reportCard.classList.remove("hidden");
            if (report.warnings.length > 0) {
              logPre.textContent += `\n[WARN] ${report.warnings.join(' ')}\n`;
            }

            avgDeEl.textContent = report.avgDe.toFixed(2);
            maxDeEl.textContent = report.maxDe.toFixed(2);
            rmsDeEl.textContent = report.rmsDe.toFixed(2);

            // Quality verdict
            badgeEl.className = "report-badge";
            if (report.avgDe < 1.0) {
              badgeEl.textContent = "EXCELLENT";
              badgeEl.classList.add("badge-excellent");
            } else if (report.avgDe < 2.0) {
              badgeEl.textContent = "GOOD";
              badgeEl.classList.add("badge-good");
            } else if (report.avgDe < 3.5) {
              badgeEl.textContent = "ACCEPTABLE";
              badgeEl.classList.add("badge-acceptable");
            } else {
              badgeEl.textContent = "POOR";
              badgeEl.classList.add("badge-poor");
            }

            // Auto-save record to verification history
            const record = {
              id: "",
              timestamp: new Date().toISOString(),
              printer_name: wizardState.printerName || "Unknown",
              profile_name: profileBasename || wizardState.basename || "Unknown",
              avg_de: report.avgDe,
              max_de: report.maxDe,
              rms_de: report.rmsDe,
              patch_count: report.patchCount,
              status: "",
            };

            try {
              await invoke("save_verification_record", { record });
            } catch (saveErr) {
              logger.warn(`Could not auto-save verification record: ${saveErr}`, 'Stage5-Profcheck');
              logPre.textContent += `\n[WARN] Could not auto-save verification record: ${saveErr}\n`;
            }

            // Refresh verification history display
            await loadVerificationHistory();

            // Ensure gamut mesh is loaded into 3D viewer
            const gamFilePath = cwd ? `${cwd}${sep}${basename}.gam` : `${basename}.gam`;
            try {
              const result = await loadGamutMesh(gamFilePath);
              if (!result) {
                logPre.textContent += `\n[WARN] Could not render 3D gamut mesh from ${gamFilePath}.\n`;
              }
            } catch (gamErr) {
              logPre.textContent += `\n[WARN] 3D gamut render failed: ${gamErr}\n`;
            }
          } else {
            logPre.textContent += `\n[ERROR] profcheck exited with code ${event.payload.code}.\n`;
          }
        }
      });

      await invoke("run_profcheck", { config });
    } catch (err) {
      logger.error(`run_profcheck invocation failed: ${err}`, 'Stage5-Profcheck');
      logPre.textContent += `\n[INVOKE ERROR] ${err}\n`;
      btnVerify.disabled = false;
    }
  });
}
