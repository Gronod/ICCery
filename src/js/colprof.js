const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
import { setStage4Result } from './profcheck.js';
import { loadGamutMesh } from './gamut_viewer.js';

let chartreadBasename = "";
let chartreadCwd = "";

/**
 * Called by chartread.js after Stage 3 completes.
 */
export function setStage3Result(basename, cwd) {
  chartreadBasename = basename;
  chartreadCwd = cwd;
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

  if (!btnCreateProfile) return;

  btnCreateProfile.addEventListener("click", async () => {
    const basename = chartreadBasename || "test_target";
    const cwd = chartreadCwd || "";

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
  const steps = document.querySelectorAll('.step');
  const stages = document.querySelectorAll('.stage');

  steps.forEach(s => s.classList.remove('active'));
  if (steps[4]) steps[4].classList.add('active');

  stages.forEach(s => {
    s.classList.remove('active');
    s.classList.add('hidden');
  });
  if (stages[4]) {
    stages[4].classList.remove('hidden');
    stages[4].classList.add('active');
  }
}
