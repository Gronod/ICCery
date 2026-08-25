const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
import { startSwatchListener, stopSwatchListener } from './swatch_grid.js';
import { setStage3Result } from './colprof.js';
import { wizardState } from './state.js';

// Module-level state: set by Stage 2 when it completes
let stage2Basename = "";
let stage2Cwd = "";

/**
 * Called by printtarg.js after Stage 2 completes.
 */
export function setStage2Result(basename, cwd) {
  stage2Basename = basename || wizardState.basename;
  stage2Cwd = cwd || wizardState.cwd;
  wizardState.setTarget(stage2Basename, stage2Cwd);
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
  const btnDetectInstruments = document.getElementById("btnDetectInstruments");
  const instrumentSelect = document.getElementById("chartreadInstrumentSelect");
  const promptText = document.getElementById("chartreadPrompt");
  const stateLabel = document.getElementById("chartreadState");
  const logContainer = document.getElementById("chartreadLogContainer");
  const logPre = document.getElementById("chartreadLog");

  // Instrument detection logic
  if (btnDetectInstruments && instrumentSelect) {
    btnDetectInstruments.addEventListener("click", async () => {
      btnDetectInstruments.disabled = true;
      btnDetectInstruments.textContent = "Detecting...";
      setPrompt("Querying connected spectrophotometers and colorimeters via instlist...");

      const detected = [];

      try {
        const unlistenStdout = await listen("process:stdout", (event) => {
          if (event.payload.id !== "instlist" || !event.payload.line) return;
          const line = event.payload.line.trim();

          // Matches Argyll instlist output e.g. "1: 'i1Pro' on 'USB'" or "1: 'ColorMunki'" or "1 = 'i1Display'"
          const match = line.match(/^(\d+)[\s:=]+'?([^'\n]+)'?(?:\s+on\s+'?([^'\n]+)'?)?/i);
          if (match) {
            const index = match[1];
            const name = match[2].trim();
            const port = match[3] ? match[3].trim() : "";
            detected.push({ index, name, port });
          }
        });

        const unlistenExit = await listen("process:exit", (event) => {
          if (event.payload.id !== "instlist") return;
          unlistenStdout();
          unlistenExit();
          btnDetectInstruments.disabled = false;
          btnDetectInstruments.textContent = "↻ Detect";

          instrumentSelect.innerHTML = `<option value="">Auto-Detect (First Available Instrument)</option>`;

          if (detected.length > 0) {
            detected.forEach((inst) => {
              const opt = document.createElement("option");
              opt.value = inst.index;
              opt.textContent = `${inst.index}: ${inst.name} ${inst.port ? `(${inst.port})` : ""}`;
              instrumentSelect.appendChild(opt);
            });
            instrumentSelect.value = detected[0].index;
            setPrompt(`Found ${detected.length} instrument(s): ${detected.map(d => d.name).join(", ")}`);
          } else {
            setPrompt("No instruments found via instlist. Ensure USB cable is plugged in.");
          }
        });

        await invoke("detect_instruments");
      } catch (err) {
        console.error("detect_instruments error:", err);
        btnDetectInstruments.disabled = false;
        btnDetectInstruments.textContent = "↻ Detect";
        setPrompt(`Instrument detection error: ${err}`);
      }
    });
  }

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
      const basename = stage2Basename || wizardState.basename;
      const cwd = stage2Cwd || wizardState.cwd;

      if (!basename || !cwd) {
        setPrompt("Error: No .ti2 file available. Complete Stage 2 first.");
        return;
      }

      stage2Basename = basename;
      stage2Cwd = cwd;

      logPre.textContent = "";
      logContainer.open = false;
      logContainer.classList.remove("hidden");
      setState(STATE.CALIBRATING);
      setPrompt("Starting chartread... waiting for instrument calibration prompt.");

      const selectedPort = instrumentSelect && instrumentSelect.value ? instrumentSelect.value : null;

      const config = {
        basename: basename,
        cwd: cwd,
        port: selectedPort,
      };

      currentProcessId = `chartread_${basename}`;

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
            wizardState.setTarget(basename, cwd);
            setStage3Result(basename, cwd);
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
