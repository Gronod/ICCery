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

  if (!btnVerify) return;

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
            parseAndRenderReport(stdoutAccumulator);

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

  /**
   * Parse profcheck output for Average, Peak, and RMS delta-E values.
   * Supports both Argyll's JSON-style summary and plain-text legacy output.
   * @param {string} stdout - Full profcheck stdout.
   */
  function parseAndRenderReport(stdout) {
    reportCard.classList.remove("hidden");

    let avgDe = 0.0;
    let maxDe = 0.0;
    let rmsDe = 0.0;
    let parserWarnings = [];

    // Argyll's JSON output can appear either as a compact object on a single
    // line or embedded inside larger text. Try to find and parse the LAST valid
    // JSON object in the output, which is most likely the summary.
    const jsonObjects = [];
    const re = /\{[\s\S]*?\}/g;
    let m;
    while ((m = re.exec(stdout)) !== null) {
      try {
        const parsed = JSON.parse(m[0]);
        if (typeof parsed === 'object' && parsed !== null && ('avg_de' in parsed || 'peak_de' in parsed || 'rms_de' in parsed)) {
          jsonObjects.push(parsed);
        }
      } catch (e) {
        // Not a valid JSON object, ignore.
      }
    }

    if (jsonObjects.length > 0) {
      const json = jsonObjects[jsonObjects.length - 1];
      avgDe = typeof json.avg_de === 'number' ? json.avg_de : 0;
      maxDe = typeof json.max_de === 'number' ? json.max_de : (typeof json.peak_de === 'number' ? json.peak_de : 0);
      rmsDe = typeof json.rms_de === 'number' ? json.rms_de : 0;
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
        /RMS\s*(?:dE\s*)?[:=]\s*([\d\.]+)/i,
        /rms\s*(?:dE\s*)?([\d\.]+)/i,
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
      else parserWarnings.push('Could not detect Average ΔE in profcheck output.');

      if (maxMatch) maxDe = parseFloat(maxMatch[1]);
      else parserWarnings.push('Could not detect Peak ΔE in profcheck output.');

      if (rmsMatch) rmsDe = parseFloat(rmsMatch[1]);
      else parserWarnings.push('Could not detect RMS ΔE in profcheck output.');

      if (!avgMatch && !maxMatch && !rmsMatch) {
        parserWarnings.push('No delta-E values were found in profcheck output.');
      }
    }

    if (parserWarnings.length > 0) {
      logPre.textContent += `\n[WARN] ${parserWarnings.join(' ')}\n`;
    }

    avgDeEl.textContent = avgDe.toFixed(2);
    maxDeEl.textContent = maxDe.toFixed(2);
    rmsDeEl.textContent = rmsDe.toFixed(2);

    // Quality verdict
    badgeEl.className = "report-badge";
    if (avgDe < 1.0) {
      badgeEl.textContent = "EXCELLENT";
      badgeEl.classList.add("badge-excellent");
    } else if (avgDe < 2.0) {
      badgeEl.textContent = "GOOD";
      badgeEl.classList.add("badge-good");
    } else if (avgDe < 4.0) {
      badgeEl.textContent = "ACCEPTABLE";
      badgeEl.classList.add("badge-acceptable");
    } else {
      badgeEl.textContent = "POOR";
      badgeEl.classList.add("badge-poor");
    }
  }
}
