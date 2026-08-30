const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
import { setStage1Result } from './printtarg.js';
import { populateStage3TargetContext } from './chartread.js';
import { wizardState } from './state.js';
import { logger } from './logger.js';

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

  // Advanced controls
  const targenGreySteps = document.getElementById("targenGreySteps");
  const targenSingleChannelSteps = document.getElementById("targenSingleChannelSteps");
  const targenPrecondProfile = document.getElementById("targenPrecondProfile");
  const btnBrowsePrecondProfile = document.getElementById("btnBrowsePrecondProfile");
  const targenNeutralSteps = document.getElementById("targenNeutralSteps");
  const targenNeutralConcentration = document.getElementById("targenNeutralConcentration");
  const targenNeutralConcVal = document.getElementById("targenNeutralConcVal");
  const targenAlgorithm = document.getElementById("targenAlgorithm");
  const targenHighQuality = document.getElementById("targenHighQuality");
  const targenAdaptation = document.getElementById("targenAdaptation");
  const targenAdaptationVal = document.getElementById("targenAdaptationVal");
  const targenInkLimit = document.getElementById("targenInkLimit");
  const targenDarkEmphasis = document.getElementById("targenDarkEmphasis");
  const targenDarkEmphasisVal = document.getElementById("targenDarkEmphasisVal");
  const targenDevicePower = document.getElementById("targenDevicePower");
  const btnToggleAllHelp = document.getElementById("btnToggleAllHelp");
  const stage1FormContainer = document.getElementById("stage1FormContainer");

  let currentWorkingDir = "";

  // Help hints toggle
  if (btnToggleAllHelp && stage1FormContainer) {
    btnToggleAllHelp.addEventListener("click", () => {
      stage1FormContainer.classList.toggle("show-all-tooltips");
      if (stage1FormContainer.classList.contains("show-all-tooltips")) {
        btnToggleAllHelp.textContent = "💡 Hide Tooltip Hints";
      } else {
        btnToggleAllHelp.textContent = "💡 Show Tooltip Hints";
      }
    });
  }

  // Sliders dynamic display
  if (targenNeutralConcentration && targenNeutralConcVal) {
    targenNeutralConcentration.addEventListener("input", (e) => {
      targenNeutralConcVal.textContent = parseFloat(e.target.value).toFixed(2);
    });
  }
  if (targenAdaptation && targenAdaptationVal) {
    targenAdaptation.addEventListener("input", (e) => {
      targenAdaptationVal.textContent = parseFloat(e.target.value).toFixed(2);
    });
  }
  if (targenDarkEmphasis && targenDarkEmphasisVal) {
    targenDarkEmphasis.addEventListener("input", (e) => {
      targenDarkEmphasisVal.textContent = parseFloat(e.target.value).toFixed(2);
    });
  }

  // Colour space change listener to enable/disable ink limit
  colourSpaceRadios.forEach((radio) => {
    radio.addEventListener("change", (e) => {
      const isCmyk = e.target.value === "cmyk";
      if (targenInkLimit) {
        targenInkLimit.disabled = !isCmyk;
        if (!isCmyk) {
          targenInkLimit.value = "";
        }
      }
      if (blackPatches) {
        if (isCmyk && (!blackPatches.value || blackPatches.value === "4")) {
          blackPatches.value = "0";
        } else if (!isCmyk && (!blackPatches.value || blackPatches.value === "0")) {
          blackPatches.value = "4";
        }
      }
    });
  });

  // Browse preconditioning profile
  if (btnBrowsePrecondProfile && targenPrecondProfile) {
    btnBrowsePrecondProfile.addEventListener("click", async () => {
      try {
        const filePath = await invoke("select_existing_target", {
          defaultDir: currentWorkingDir || null,
        });
        if (filePath) {
          targenPrecondProfile.value = filePath;
          if (targenAdaptation && targenAdaptation.value === "0.1") {
            targenAdaptation.value = "1.0";
            if (targenAdaptationVal) targenAdaptationVal.textContent = "1.00";
          }
        }
      } catch (err) {
        console.error("Failed to select preconditioning profile:", err);
      }
    });
  }

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
          wizardState.setTarget(basename, currentWorkingDir);
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
        grey_steps: (targenGreySteps && targenGreySteps.value) ? parseInt(targenGreySteps.value, 10) : null,
        single_channel_steps: (targenSingleChannelSteps && targenSingleChannelSteps.value) ? parseInt(targenSingleChannelSteps.value, 10) : null,
        preconditioning_profile: (targenPrecondProfile && targenPrecondProfile.value.trim()) ? targenPrecondProfile.value.trim() : null,
        neutral_steps: (targenNeutralSteps && targenNeutralSteps.value) ? parseInt(targenNeutralSteps.value, 10) : null,
        neutral_concentration: (targenNeutralConcentration) ? parseFloat(targenNeutralConcentration.value) : null,
        ofps_high_quality: (targenHighQuality) ? targenHighQuality.checked : false,
        ofps_adaptation: (targenAdaptation) ? parseFloat(targenAdaptation.value) : null,
        full_spread_algorithm: (targenAlgorithm && targenAlgorithm.value !== "ofps") ? targenAlgorithm.value : null,
        total_ink_limit: (colourSpace === "cmyk" && targenInkLimit && targenInkLimit.value) ? parseInt(targenInkLimit.value, 10) : null,
        dark_emphasis: (targenDarkEmphasis) ? parseFloat(targenDarkEmphasis.value) : null,
        device_power: (targenDevicePower && targenDevicePower.value) ? parseFloat(targenDevicePower.value) : null,
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
        logger.error(`run_targen invocation failed: ${err}`, 'Stage1-Targen');
        if (logPre) logPre.textContent += `\n[INVOKE ERROR] ${err}\n`;
        btnGenerate.disabled = false;
      }
    });
  }
}

function advanceToStage2() {
  wizardState.navigateToStage(2);
}
