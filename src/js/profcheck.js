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
            loadGamutMesh(gamFilePath, 0x3b82f6);
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

  function parseAndRenderReport(stdout) {
    reportCard.classList.remove("hidden");

    let avgDe = 0.0;
    let maxDe = 0.0;
    let rmsDe = 0.0;

    // Check if JSON output is present
    const jsonMatch = stdout.match(/\{[\s\S]*"avg_de"[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const json = JSON.parse(jsonMatch[0]);
        avgDe = json.avg_de || 0;
        maxDe = json.max_de || json.peak_de || 0;
        rmsDe = json.rms_de || 0;
      } catch (e) {
        console.error("JSON parse error:", e);
      }
    } else {
      // Regex fallbacks for standard profcheck output
      const avgMatch = stdout.match(/avg\.\s*dE\s*=\s*([\d\.]+)/i) || stdout.match(/average\s*dE\s*:\s*([\d\.]+)/i);
      const maxMatch = stdout.match(/max\.\s*dE\s*=\s*([\d\.]+)/i) || stdout.match(/peak\s*dE\s*:\s*([\d\.]+)/i);
      const rmsMatch = stdout.match(/rms\.\s*dE\s*=\s*([\d\.]+)/i) || stdout.match(/rms\s*dE\s*:\s*([\d\.]+)/i);

      if (avgMatch) avgDe = parseFloat(avgMatch[1]);
      if (maxMatch) maxDe = parseFloat(maxMatch[1]);
      if (rmsMatch) rmsDe = parseFloat(rmsMatch[1]);
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
