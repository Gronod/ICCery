const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
import { startSwatchListener, stopSwatchListener } from './swatch_grid.js';

// Module-level state: set by Stage 2 when it completes
let stage2Basename = "";
let stage2Cwd = "";

/**
 * Called by printtarg.js after Stage 2 completes.
 */
export function setStage2Result(basename, cwd) {
  stage2Basename = basename;
  stage2Cwd = cwd;
}

// State machine states
const STATE = {
  IDLE: "IDLE",
  CALIBRATING: "CALIBRATING",
  AWAITING_STRIP: "AWAITING_STRIP",
  READING: "READING",
  ERROR: "ERROR",
  FINISHED: "FINISHED",
};

let currentState = STATE.IDLE;
let currentProcessId = "";

export function initChartread() {
  const btnStartRead = document.getElementById("btnStartRead");
  const btnCalibrate = document.getElementById("btnCalibrate");
  const btnRetry = document.getElementById("btnRetry");
  const btnSkip = document.getElementById("btnSkip");
  const btnCancel = document.getElementById("btnCancel");
  const promptText = document.getElementById("chartreadPrompt");
  const stateLabel = document.getElementById("chartreadState");
  const logContainer = document.getElementById("chartreadLogContainer");
  const logPre = document.getElementById("chartreadLog");

  function setState(newState) {
    currentState = newState;
    if (stateLabel) stateLabel.textContent = newState;

    // Show/hide buttons based on state
    btnCalibrate.classList.add("hidden");
    btnRetry.classList.add("hidden");
    btnSkip.classList.add("hidden");
    btnCancel.classList.add("hidden");
    btnStartRead.classList.add("hidden");

    switch (newState) {
      case STATE.IDLE:
        btnStartRead.classList.remove("hidden");
        break;
      case STATE.CALIBRATING:
        btnCalibrate.classList.remove("hidden");
        btnCancel.classList.remove("hidden");
        break;
      case STATE.AWAITING_STRIP:
        btnRetry.classList.remove("hidden");
        btnSkip.classList.remove("hidden");
        btnCancel.classList.remove("hidden");
        break;
      case STATE.READING:
        btnCancel.classList.remove("hidden");
        break;
      case STATE.ERROR:
        btnRetry.classList.remove("hidden");
        btnSkip.classList.remove("hidden");
        btnCancel.classList.remove("hidden");
        break;
      case STATE.FINISHED:
        btnStartRead.classList.remove("hidden");
        break;
    }
  }

  function setPrompt(text) {
    if (promptText) promptText.textContent = text;
  }

  // Start reading button
  if (btnStartRead) {
    btnStartRead.addEventListener("click", async () => {
      if (!stage2Basename) {
        setPrompt("Error: No .ti2 file available. Complete Stage 2 first.");
        return;
      }

      logPre.textContent = "";
      logContainer.classList.remove("hidden");
      setState(STATE.CALIBRATING);
      setPrompt("Starting chartread... waiting for instrument calibration prompt.");

      const config = {
        basename: stage2Basename,
        cwd: stage2Cwd,
      };

      currentProcessId = `chartread_${stage2Basename}`;

      // Start swatch grid listener
      await startSwatchListener(currentProcessId);

      try {
        const unlistenStdout = await listen("process:stdout", (event) => {
          if (event.payload.id !== currentProcessId || !event.payload.line) return;
          const line = event.payload.line;

          logPre.textContent += line + "\n";
          logPre.scrollTop = logPre.scrollHeight;

          // Parse prompts for state transitions
          const lineLower = line.toLowerCase();

          if (lineLower.includes("calibrat") && lineLower.includes("place")) {
            setState(STATE.CALIBRATING);
            setPrompt(line);
          } else if (lineLower.includes("hit") && lineLower.includes("read") && lineLower.includes("strip")) {
            setState(STATE.AWAITING_STRIP);
            setPrompt(line);
          } else if (lineLower.includes("ready to read")) {
            setState(STATE.AWAITING_STRIP);
            setPrompt(line);
          } else if (lineLower.includes("reading strip") || lineLower.includes("processing")) {
            setState(STATE.READING);
            setPrompt(line);
          } else if (lineLower.includes("error") || lineLower.includes("too fast") || lineLower.includes("too slow") || lineLower.includes("misread")) {
            setState(STATE.ERROR);
            setPrompt("⚠️ " + line);
          }
        });

        const unlistenStderr = await listen("process:stderr", (event) => {
          if (event.payload.id === currentProcessId && event.payload.line) {
            logPre.textContent += "ERR: " + event.payload.line + "\n";
            logPre.scrollTop = logPre.scrollHeight;
          }
        });

        const unlistenExit = await listen("process:exit", (event) => {
          if (event.payload.id !== currentProcessId) return;
          unlistenStdout();
          unlistenStderr();
          unlistenExit();
          stopSwatchListener();

          if (event.payload.code === 0) {
            setState(STATE.FINISHED);
            setPrompt("✅ Measurement complete! .ti3 file has been saved.");
            logPre.textContent += "\n[SUCCESS] chartread completed. .ti3 file written.\n";
            advanceToStage4();
          } else {
            setState(STATE.FINISHED);
            setPrompt(`❌ chartread exited with code ${event.payload.code}.`);
            logPre.textContent += `\n[ERROR] chartread exited with code ${event.payload.code}.\n`;
          }
        });

        await invoke("run_chartread", { config });

      } catch (err) {
        setPrompt(`Invoke error: ${err}`);
        setState(STATE.IDLE);
      }
    });
  }

  // Calibrate / confirm button — sends space + newline
  if (btnCalibrate) {
    btnCalibrate.addEventListener("click", async () => {
      try {
        await invoke("send_stdin", { id: currentProcessId, input: " \n" });
      } catch (e) { console.error("send_stdin error:", e); }
    });
  }

  // Retry button — sends space + newline (same as confirm)
  if (btnRetry) {
    btnRetry.addEventListener("click", async () => {
      try {
        await invoke("send_stdin", { id: currentProcessId, input: " \n" });
        setState(STATE.READING);
        setPrompt("Retrying strip read...");
      } catch (e) { console.error("send_stdin error:", e); }
    });
  }

  // Skip button — sends "s\n"
  if (btnSkip) {
    btnSkip.addEventListener("click", async () => {
      try {
        await invoke("send_stdin", { id: currentProcessId, input: "s\n" });
        setState(STATE.AWAITING_STRIP);
        setPrompt("Skipped current strip. Awaiting next...");
      } catch (e) { console.error("send_stdin error:", e); }
    });
  }

  // Cancel button — kills the process
  if (btnCancel) {
    btnCancel.addEventListener("click", async () => {
      try {
        await invoke("kill_process", { id: currentProcessId });
        stopSwatchListener();
        setState(STATE.IDLE);
        setPrompt("Measurement cancelled.");
      } catch (e) { console.error("kill_process error:", e); }
    });
  }

  // Start in IDLE state
  setState(STATE.IDLE);
  setPrompt("Press 'Start Measurement' to begin reading the printed target.");
}

function advanceToStage4() {
  const steps = document.querySelectorAll('.step');
  const stages = document.querySelectorAll('.stage');

  steps.forEach(s => s.classList.remove('active'));
  if (steps[3]) steps[3].classList.add('active');

  stages.forEach(s => {
    s.classList.remove('active');
    s.classList.add('hidden');
  });
  if (stages[3]) {
    stages[3].classList.remove('hidden');
    stages[3].classList.add('active');
  }
}
