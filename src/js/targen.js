const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
import { setStage1Result } from './printtarg.js';
import { populateStage3TargetContext } from './chartread.js';
import { wizardState } from './state.js';

export function initTargen() {
  const colourSpaceRadios = document.querySelectorAll('input[name="colourSpace"]');
  const patchCountPreset = document.getElementById("patchCountPreset");
  const patchCountCustom = document.getElementById("patchCountCustom");
  const whitePatches = document.getElementById("whitePatches");
  const blackPatches = document.getElementById("blackPatches");
  const targetBasename = document.getElementById("targetBasename");
  const selectedPathDisplay = document.getElementById("selectedPathDisplay");
  const btnBrowse = document.getElementById("btnBrowse");
  const btnOpenExisting = document.getElementById("btnOpenExisting");
  const btnGenerate = document.getElementById("btnGenerate");
  const logContainer = document.getElementById("targenLogContainer");
  const logPre = document.getElementById("targenLog");

  let currentWorkingDir = "";

  function updateGenerateButton() {
    const hasBasename = targetBasename && targetBasename.value.trim().length > 0;
    const hasCwd = currentWorkingDir && currentWorkingDir.trim().length > 0;
    if (btnGenerate) {
      btnGenerate.disabled = !(hasBasename && hasCwd);
    }
  }

  // Load sensible default working directory on startup
  invoke("get_default_working_dir")
    .then((defaultDir) => {
      if (defaultDir) {
        currentWorkingDir = defaultDir;
        if (selectedPathDisplay) {
          selectedPathDisplay.textContent = `Directory: ${currentWorkingDir}`;
        }
        updateGenerateButton();
      }
    })
    .catch((err) => {
      console.warn("Could not retrieve default working directory:", err);
    });

  // Handle patch count preset changes
  if (patchCountPreset && patchCountCustom) {
    patchCountPreset.addEventListener("change", (e) => {
      if (e.target.value === "custom") {
        patchCountCustom.classList.remove("hidden");
      } else {
        patchCountCustom.classList.add("hidden");
      }
    });
  }

  // Enable generate button when basename is input
  if (targetBasename) {
    targetBasename.addEventListener("input", () => {
      if (!currentWorkingDir) {
        invoke("get_default_working_dir")
          .then((defaultDir) => {
            if (defaultDir) {
              currentWorkingDir = defaultDir;
              if (selectedPathDisplay) {
                selectedPathDisplay.textContent = `Directory: ${currentWorkingDir}`;
              }
            }
            updateGenerateButton();
          })
          .catch(() => updateGenerateButton());
      } else {
        updateGenerateButton();
      }
    });
  }

  // Browse button opens save dialog via backend command
  if (btnBrowse) {
    btnBrowse.addEventListener("click", async () => {
      try {
        const filePath = await invoke("select_target_file", {
          defaultDir: currentWorkingDir || null,
          defaultName: targetBasename ? targetBasename.value.trim() || null : null,
        });

        if (filePath) {
          // Normalize separators to locate directory and filename
          const isWindows = filePath.includes('\\');
          const sep = isWindows ? '\\' : '/';
          const parts = filePath.split(sep);
          const fileName = parts.pop();

          currentWorkingDir = parts.join(sep);
          const basename = fileName.replace(/\.ti1$/i, '');

          if (targetBasename) {
            targetBasename.value = basename;
          }
          if (selectedPathDisplay) {
            selectedPathDisplay.textContent = `Directory: ${currentWorkingDir}`;
          }
          updateGenerateButton();
        }
      } catch (err) {
        console.error("Failed to open file dialog:", err);
      }
    });
  }

  // Open existing target (.ti1 or .ti2)
  if (btnOpenExisting) {
    btnOpenExisting.addEventListener("click", async () => {
      try {
        const filePath = await invoke("select_existing_target", {
          defaultDir: currentWorkingDir || null,
        });

        if (filePath) {
          const isWindows = filePath.includes('\\');
          const sep = isWindows ? '\\' : '/';
          const parts = filePath.split(sep);
          const fileName = parts.pop();
          const isTi2 = fileName.toLowerCase().endsWith('.ti2');

          currentWorkingDir = parts.join(sep);
          const basename = fileName.replace(/\.(ti1|ti2)$/i, '');

          if (targetBasename) {
            targetBasename.value = basename;
          }
          if (selectedPathDisplay) {
            selectedPathDisplay.textContent = `Directory: ${currentWorkingDir}`;
          }
          updateGenerateButton();

          if (isTi2) {
            // Parse .ti2 metadata and jump straight to Stage 3
            try {
              const meta = await invoke("parse_ti2_header", { filePath });
              await wizardState.setTarget(meta.basename, meta.cwd);
              populateStage3TargetContext(meta);
              wizardState.navigateToStage(3);
            } catch (parseErr) {
              console.warn("Could not parse .ti2 header, navigating with basic target:", parseErr);
              await wizardState.setTarget(basename, currentWorkingDir);
              populateStage3TargetContext({ basename, cwd: currentWorkingDir });
              wizardState.navigateToStage(3);
            }
          } else {
            // .ti1 selected -> advance to Stage 2 (Print Layout)
            await wizardState.setTarget(basename, currentWorkingDir);
            setStage1Result(basename, currentWorkingDir);
            wizardState.navigateToStage(2);
          }
        }
      } catch (err) {
        console.error("Failed to open existing target:", err);
      }
    });
  }

  // Generate button clicks
  if (btnGenerate) {
    btnGenerate.addEventListener("click", async () => {
      const basename = targetBasename ? targetBasename.value.trim() : "";
      if (!currentWorkingDir || !basename) {
        if (logPre) {
          logPre.textContent = "[ERROR] Please specify both a target basename and a working directory.\n";
        }
        if (logContainer) {
          logContainer.open = true;
          logContainer.classList.remove("hidden");
        }
        btnGenerate.disabled = false;
        return;
      }

      if (logPre) logPre.textContent = "";
      if (logContainer) {
        logContainer.open = false;
        logContainer.classList.remove("hidden");
      }
      btnGenerate.disabled = true;

      // Determine patch count
      let patchCount = 800;
      if (patchCountPreset) {
        patchCount = parseInt(patchCountPreset.value, 10);
        if (patchCountPreset.value === "custom" && patchCountCustom) {
          const customVal = parseInt(patchCountCustom.value, 10);
          patchCount = (!isNaN(customVal) && customVal > 0) ? customVal : 800;
        }
      }
      if (isNaN(patchCount) || patchCount <= 0) {
        patchCount = 800;
      }

      // Determine colour space
      let colourSpace = "rgb";
      colourSpaceRadios.forEach((radio) => {
        if (radio.checked) colourSpace = radio.value;
      });

      const config = {
        colour_space: colourSpace,
        patch_count: patchCount,
        total_patches: patchCount,
        white_patches: (whitePatches && whitePatches.value) ? parseInt(whitePatches.value, 10) : null,
        black_patches: (blackPatches && blackPatches.value) ? parseInt(blackPatches.value, 10) : null,
        basename: basename,
        cwd: currentWorkingDir,
      };

      try {
        const processId = `targen_${basename}`;

        const unlistenStdout = await listen("process:stdout", (event) => {
          if (event.payload.id === processId && event.payload.line && logPre) {
            logPre.textContent += event.payload.line + "\n";
            logPre.scrollTop = logPre.scrollHeight;
          }
        });

        const unlistenStderr = await listen("process:stderr", (event) => {
          if (event.payload.id === processId && event.payload.line && logPre) {
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
              if (logPre) logPre.textContent += "\n[SUCCESS] Targen completed successfully.\n";
              btnGenerate.disabled = false;
              wizardState.setTarget(basename, currentWorkingDir);
              setStage1Result(basename, currentWorkingDir);
              advanceToStage2();
            } else {
              if (logPre) logPre.textContent += `\n[ERROR] Targen exited with code ${event.payload.code}.\n`;
              btnGenerate.disabled = false;
            }
          }
        });

        if (logPre) logPre.textContent = "Starting targen...\n";
        await invoke("run_targen", { config });
      } catch (err) {
        if (logPre) logPre.textContent += `\n[INVOKE ERROR] ${err}\n`;
        btnGenerate.disabled = false;
      }
    });
  }
}

function advanceToStage2() {
  const steps = document.querySelectorAll('.step');
  const stages = document.querySelectorAll('.stage');

  // Update stepper
  steps.forEach((s) => s.classList.remove('active'));
  if (steps[1]) steps[1].classList.add('active');

  // Update sections
  stages.forEach((s) => {
    s.classList.remove('active');
    s.classList.add('hidden');
  });
  if (stages[1]) {
    stages[1].classList.remove('hidden');
    stages[1].classList.add('active');
  }
}
