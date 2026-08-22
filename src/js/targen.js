import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";

export function initTargen() {
  const colourSpaceRadios = document.querySelectorAll('input[name="colourSpace"]');
  const patchCountPreset = document.getElementById("patchCountPreset");
  const patchCountCustom = document.getElementById("patchCountCustom");
  const whitePatches = document.getElementById("whitePatches");
  const blackPatches = document.getElementById("blackPatches");
  const targetBasename = document.getElementById("targetBasename");
  const selectedPathDisplay = document.getElementById("selectedPathDisplay");
  const btnBrowse = document.getElementById("btnBrowse");
  const btnGenerate = document.getElementById("btnGenerate");
  const logContainer = document.getElementById("targenLogContainer");
  const logPre = document.getElementById("targenLog");

  let currentWorkingDir = "";
  let currentBasename = "";

  // Handle patch count preset changes
  patchCountPreset.addEventListener("change", (e) => {
    if (e.target.value === "custom") {
      patchCountCustom.classList.remove("hidden");
    } else {
      patchCountCustom.classList.add("hidden");
    }
  });

  // Browse button opens save dialog
  btnBrowse.addEventListener("click", async () => {
    try {
      const filePath = await save({
        title: "Save Target File As...",
        filters: [{
          name: "ArgyllCMS Target",
          extensions: ["ti1"]
        }]
      });
      
      if (filePath) {
        // Simple extraction of directory and basename. 
        // Example: /home/user/my_paper.ti1 -> /home/user and my_paper
        const isWindows = filePath.includes('\\');
        const sep = isWindows ? '\\' : '/';
        const parts = filePath.split(sep);
        const fileName = parts.pop();
        
        currentWorkingDir = parts.join(sep);
        currentBasename = fileName.replace(/\.ti1$/i, '');
        
        targetBasename.value = currentBasename;
        selectedPathDisplay.textContent = filePath;
        
        // Enable generate button
        btnGenerate.disabled = false;
      }
    } catch (err) {
      console.error("Failed to open save dialog:", err);
    }
  });

  // Generate button clicks
  btnGenerate.addEventListener("click", async () => {
    logPre.textContent = "";
    logContainer.classList.remove("hidden");
    btnGenerate.disabled = true;
    
    // Determine patch count
    let patchCount = parseInt(patchCountPreset.value, 10);
    if (patchCountPreset.value === "custom") {
      patchCount = parseInt(patchCountCustom.value, 10);
    }
    
    // Determine colour space
    let colourSpace = "rgb";
    colourSpaceRadios.forEach(radio => {
      if (radio.checked) colourSpace = radio.value;
    });

    const config = {
      colour_space: colourSpace,
      patch_count: patchCount,
      white_patches: whitePatches.value ? parseInt(whitePatches.value, 10) : null,
      black_patches: blackPatches.value ? parseInt(blackPatches.value, 10) : null,
      basename: currentBasename,
      cwd: currentWorkingDir
    };

    try {
      // Set up listeners just for this run
      const processId = `targen_${currentBasename}`;
      
      const unlistenStdout = await listen("process:stdout", (event) => {
        if (event.payload.id === processId && event.payload.line) {
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

      const unlistenExit = await listen("process:exit", (event) => {
        if (event.payload.id === processId) {
          unlistenStdout();
          unlistenStderr();
          unlistenExit();
          
          if (event.payload.code === 0) {
            logPre.textContent += "\n[SUCCESS] Targen completed successfully.\n";
            // In a real app we'd dispatch an event to advance the stepper here.
            // For now, we'll manually unlock stage 2 in the state.
            btnGenerate.disabled = false;
            advanceToStage2();
          } else {
            logPre.textContent += `\n[ERROR] Targen exited with code ${event.payload.code}.\n`;
            btnGenerate.disabled = false;
          }
        }
      });

      logPre.textContent = "Starting targen...\n";
      await invoke("run_targen", { config });
      
    } catch (err) {
      logPre.textContent += `\n[INVOKE ERROR] ${err}\n`;
      btnGenerate.disabled = false;
    }
  });
}

function advanceToStage2() {
  const steps = document.querySelectorAll('.step');
  const stages = document.querySelectorAll('.stage');
  
  // Update stepper
  steps.forEach(s => s.classList.remove('active'));
  if (steps[1]) steps[1].classList.add('active');
  
  // Update sections
  stages.forEach(s => {
    s.classList.remove('active');
    s.classList.add('hidden');
  });
  if (stages[1]) {
    stages[1].classList.remove('hidden');
    stages[1].classList.add('active');
  }
}
