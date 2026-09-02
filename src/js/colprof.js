const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
import { setStage4Result } from './profcheck.js';
import { loadGamutMesh } from './gamut_viewer.js';
import { wizardState } from './state.js';
import { logger } from './logger.js';

let chartreadBasename = "";
let chartreadCwd = "";

/**
 * Called by chartread.js after Stage 3 completes.
 */
export function setStage3Result(basename, cwd) {
  chartreadBasename = basename || wizardState.basename;
  chartreadCwd = cwd || wizardState.cwd;
  wizardState.setTarget(chartreadBasename, chartreadCwd);
}

export function initColprof() {
  const qualitySelect = document.getElementById("colprofQuality");
  const algorithmSelect = document.getElementById("colprofAlgorithm");
  const descInput = document.getElementById("colprofDescription");
  const copyrightInput = document.getElementById("colprofCopyright");
  const btnCreateProfile = document.getElementById("btnCreateProfile");
  const spinnerContainer = document.getElementById("colprofSpinnerContainer");
  const stageLabel = document.getElementById("colprofStageLabel");
  const logContainer = document.getElementById("colprofLogContainer");
  const logPre = document.getElementById("colprofLog");
  const successCard = document.getElementById("colprofSuccessCard");
  const successInfo = document.getElementById("colprofSuccessInfo");
  const btnGoToVerify = document.getElementById("btnGoToVerify");
  const colprofFwa = document.getElementById("colprofFwa");
  const colprofCustomSpRow = document.getElementById("colprofCustomSpRow");
  const colprofCustomSpPath = document.getElementById("colprofCustomSpPath");
  const btnBrowseCustomSp = document.getElementById("btnBrowseCustomSp");
  const colprofIlluminant = document.getElementById("colprofIlluminant");
  const colprofObserver = document.getElementById("colprofObserver");
  const colprofInputViewCond = document.getElementById("colprofInputViewCond");
  const colprofOutputViewCond = document.getElementById("colprofOutputViewCond");

  if (!btnCreateProfile) return;

  if (colprofFwa && colprofCustomSpRow) {
    colprofFwa.addEventListener("change", () => {
      if (colprofFwa.value === "custom") {
        colprofCustomSpRow.classList.remove("hidden");
      } else {
        colprofCustomSpRow.classList.add("hidden");
      }
    });
  }

  if (btnBrowseCustomSp && colprofCustomSpPath) {
    btnBrowseCustomSp.addEventListener("click", async () => {
      try {
        const selected = await window.__TAURI__.dialog.open({
          filters: [{ name: 'Spectrum', extensions: ['sp'] }]
        });
        if (selected) {
          colprofCustomSpPath.value = selected;
        }
      } catch (err) {
        console.error("Failed to open dialog:", err);
      }
    });
  }

  btnCreateProfile.addEventListener("click", async () => {
    const basename = chartreadBasename || wizardState.basename;
    const cwd = chartreadCwd || wizardState.cwd;

    if (!basename || !cwd) {
      logPre.textContent = "[ERROR] No .ti3 measurement file available. Please complete Stage 3 first.\n";
      logContainer.open = true;
      logContainer.classList.remove("hidden");
      btnCreateProfile.disabled = false;
      return;
    }

    chartreadBasename = basename;
    chartreadCwd = cwd;

    const description = descInput.value.trim() || basename;

    logPre.textContent = "";
    logContainer.open = false;
    logContainer.classList.remove("hidden");
    spinnerContainer.classList.remove("hidden");
    successCard.classList.add("hidden");
    btnCreateProfile.disabled = true;
    stageLabel.textContent = "Initializing colprof...";

    const config = {
      quality: qualitySelect.value,
      algorithm: algorithmSelect.value,
      description: description,
      copyright: copyrightInput.value.trim() || null,
      basename: basename,
      cwd: cwd,
      fwa: colprofFwa.value === "custom" ? (colprofCustomSpPath.value || "none") : colprofFwa.value,
      illuminant: colprofIlluminant.value || null,
      observer: colprofObserver.value || null,
      input_viewing_cond: colprofInputViewCond.value !== "none" ? colprofInputViewCond.value : null,
      output_viewing_cond: colprofOutputViewCond.value !== "none" ? colprofOutputViewCond.value : null,
    };

    const processId = `colprof_${basename}`;

    try {
      const unlistenStdout = await listen("process:stdout", (event) => {
        if (event.payload.id === processId && event.payload.line) {
          const line = event.payload.line;
          logPre.textContent += line + "\n";
          logPre.scrollTop = logPre.scrollHeight;

          // Parse coarse progress stages from stdout
          const lineLower = line.toLowerCase();
          if (lineLower.includes("gamut mapping")) {
            stageLabel.textContent = "Gamut mapping calculation in progress...";
          } else if (lineLower.includes("fitting") || lineLower.includes("clut")) {
            stageLabel.textContent = "Fitting cLUT grid points...";
          } else if (lineLower.includes("writing") || lineLower.includes("icc profile")) {
            stageLabel.textContent = "Writing ICC profile header & tags...";
          }
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
          spinnerContainer.classList.add("hidden");
          btnCreateProfile.disabled = false;

          if (event.payload.code === 0) {
            logPre.textContent += "\n[SUCCESS] colprof completed. Profile generated.\n";
            
            // Resolve real profile path (.icm on Windows, .icc on Unix)
            let profilePath = cwd ? `${cwd}/${basename}.icc` : `${basename}.icc`;
            try {
              profilePath = await invoke("get_profile_path", { cwd, basename });
            } catch (e) {
              console.warn("Could not query platform profile path:", e);
            }

            const displayFilename = profilePath.split(/[\\/]/).pop() || `${basename}.icc`;
            successInfo.textContent = `Profile: ${displayFilename} (${description})`;
            successCard.classList.remove("hidden");

            wizardState.setTarget(basename, cwd);
            setStage4Result(basename, cwd);

            // Automatically extract gamut mesh for 3D visualization
            triggerGamutExtraction(basename, cwd, profilePath);
          } else {
            logPre.textContent += `\n[ERROR] colprof exited with code ${event.payload.code}.\n`;
          }
        }
      });

      await invoke("run_colprof", { config });
    } catch (err) {
      logger.error(`run_colprof invocation failed: ${err}`, 'Stage4-Colprof');
      logPre.textContent += `\n[INVOKE ERROR] ${err}\n`;
      spinnerContainer.classList.add("hidden");
      btnCreateProfile.disabled = false;
    }
  });

  if (btnGoToVerify) {
    btnGoToVerify.addEventListener("click", () => {
      advanceToStage5();
    });
  }
}

async function triggerGamutExtraction(basename, cwd, profilePath) {
  try {
    const processId = `iccgamut_${basename}`;
    const unlistenExit = await listen("process:exit", (event) => {
      if (event.payload.id === processId) {
        unlistenExit();
        if (event.payload.code === 0) {
          const sep = cwd.includes('\\') ? '\\' : '/';
          const gamFilePath = cwd ? `${cwd}${sep}${basename}.gam` : `${basename}.gam`;
          loadGamutMesh(gamFilePath, 0x3b82f6);
        }
      }
    });

    await invoke("extract_gamut", { iccPath: profilePath });
  } catch (err) {
    console.warn("Automated gamut extraction notice:", err);
  }
}

function advanceToStage5() {
  wizardState.navigateToStage(5);
}
