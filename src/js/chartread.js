const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
import { startSwatchListener, stopSwatchListener } from './swatch_grid.js';
import { setStage3Result } from './colprof.js';
import { wizardState } from './state.js';
import { logger } from './logger.js';

// Module-level state: set by Stage 2 when it completes
let stage2Basename = "";
let stage2Cwd = "";

/**
 * Called by printtarg.js after Stage 2 completes, or when resuming from .ti2.
 */
export function setStage2Result(basename, cwd) {
  stage2Basename = basename || wizardState.basename;
  stage2Cwd = cwd || wizardState.cwd;
  wizardState.setTarget(stage2Basename, stage2Cwd);
  populateStage3TargetContext();
}

export function populateStage3TargetContext(metadata) {
  const banner = document.getElementById("stage3LoadedTargetBanner");
  const basenameEl = document.getElementById("stage3TargetBasename");
  const metaEl = document.getElementById("stage3TargetMeta");
  const badgeEl = document.getElementById("stage3TargetBadge");

  const basename = (metadata && metadata.basename) || stage2Basename || wizardState.basename;
  const cwd = (metadata && metadata.cwd) || stage2Cwd || wizardState.cwd;

  if (basename && banner) {
    banner.classList.remove("hidden");
    if (basenameEl) basenameEl.textContent = `${basename}.ti2`;
    if (metaEl) {
      const parts = [];
      if (metadata && metadata.patch_count) parts.push(`${metadata.patch_count} patches`);
      if (metadata && metadata.instrument) parts.push(`Instrument: ${metadata.instrument}`);
      if (cwd) parts.push(`Dir: ${cwd}`);
      metaEl.textContent = parts.join(" • ");
    }
    if (badgeEl) {
      badgeEl.textContent = metadata ? "Resumed from .ti2" : "Generated";
    }
  }
}

// State machine states
export const STATE = {
  IDLE: "IDLE",
  CALIBRATING: "CALIBRATING",
  AWAITING_STRIP: "AWAITING_STRIP",
  READING: "READING",
  ALL_STRIPS_READ: "ALL_STRIPS_READ",
  WARNING: "WARNING",
  PROMPT_CONTINUE: "PROMPT_CONTINUE",
  TABLE_PLACE_SHEET: "TABLE_PLACE_SHEET",
  TABLE_ALIGN: "TABLE_ALIGN",
  ERROR: "ERROR",
  FINISHED: "FINISHED",
};

/**
 * Classifies a line of stdout from chartread into a state transition, prompt, and metadata.
 * Pure function with no side-effects or DOM interaction.
 *
 * @param {string} line - Raw stdout line
 * @param {string} currentState - The current STATE value
 * @returns {{ state: string, prompt: string, matched: boolean, meta?: object }}
 */
export function classifyChartreadLine(line, currentState = STATE.IDLE) {
  if (typeof line !== "string") {
    return { state: currentState, prompt: "", matched: false };
  }

  const lineTrim = line.trim();
  const lineLower = lineTrim.toLowerCase();

  if (!lineTrim) {
    return { state: currentState, prompt: "", matched: false };
  }

  // 1. Info-only: Remove last sheet notice (emitted by Argyll before writing .ti3 and exiting)
  if (lineLower.includes("remove last sheet from table") || lineLower.includes("remove last sheet")) {
    return {
      state: currentState,
      prompt: lineTrim,
      matched: true,
      meta: { isRemoveSheetNotice: true },
    };
  }

  // 2. Info-only: Sheet read OK
  const sheetOkMatch = lineTrim.match(/sheet\s+(\d+)\s+of\s+(\d+)\s+read\s+ok/i);
  if (sheetOkMatch) {
    return {
      state: currentState,
      prompt: lineTrim,
      matched: true,
      meta: {
        sheetOk: true,
        sheet: parseInt(sheetOkMatch[1], 10),
        totalSheets: parseInt(sheetOkMatch[2], 10),
      },
    };
  }

  // 3. Fiducial alignment prompt (XY table)
  // e.g. "locate patch A1 with the sight," or "locate patch 1 with the sight"
  const alignMatch = lineTrim.match(/locate\s+patch\s+([A-Za-z0-9_]+)\s+with\s+(?:the\s+)?sight/i);
  if (alignMatch) {
    return {
      state: STATE.TABLE_ALIGN,
      prompt: lineTrim,
      matched: true,
      meta: { patch: alignMatch[1] },
    };
  }
  if (lineLower.includes("locate patch") && lineLower.includes("sight")) {
    const fallbackMatch = lineTrim.match(/locate\s+patch\s+([^\s,]+)/i);
    return {
      state: STATE.TABLE_ALIGN,
      prompt: lineTrim,
      matched: true,
      meta: { patch: fallbackMatch ? fallbackMatch[1] : "" },
    };
  }

  // 4. Sheet placement prompt (XY table)
  // e.g. "Please place sheet 1 of 1 on the table" or "Please remove previous sheet and place sheet 2 of 2 on the table"
  const placeMatch = lineTrim.match(/place\s+sheet\s+(\d+)\s+of\s+(\d+)/i);
  if (placeMatch) {
    return {
      state: STATE.TABLE_PLACE_SHEET,
      prompt: lineTrim,
      matched: true,
      meta: {
        sheet: parseInt(placeMatch[1], 10),
        totalSheets: parseInt(placeMatch[2], 10),
      },
    };
  }
  if (lineLower.includes("place sheet") || lineLower.includes("remove previous sheet")) {
    return {
      state: STATE.TABLE_PLACE_SHEET,
      prompt: lineTrim,
      matched: true,
      meta: {},
    };
  }

  // 5. Continuation lines ("hit return to continue...", etc.)
  // Real Argyll XY prompts are two lines:
  // Line 1: "locate patch A1 with the sight,"
  // Line 2: "then hit return to continue"
  // When line 2 arrives, if we are in TABLE_PLACE_SHEET or TABLE_ALIGN, we MUST remain sticky in that table state!
  const isContinuePrompt =
    (lineLower.includes("hit return to continue") ||
     lineLower.includes("then hit return to continue") ||
     lineLower.includes("hit return to continue, esc or 'q' to give up")) &&
    !lineLower.includes("use it anyway");

  if (isContinuePrompt) {
    if (currentState === STATE.TABLE_PLACE_SHEET) {
      return {
        state: STATE.TABLE_PLACE_SHEET,
        prompt: lineTrim,
        matched: true,
        meta: { isContinuation: true },
      };
    }
    if (currentState === STATE.TABLE_ALIGN) {
      return {
        state: STATE.TABLE_ALIGN,
        prompt: lineTrim,
        matched: true,
        meta: { isContinuation: true },
      };
    }
    return {
      state: STATE.PROMPT_CONTINUE,
      prompt: lineTrim,
      matched: true,
    };
  }

  // 6. Strip / measurement completed signals
  if (
    lineLower.includes("'d' if done") ||
    lineLower.includes("'d' when done") ||
    lineLower.includes("d if done") ||
    lineLower.includes("d when done") ||
    lineLower.includes("d to finish") ||
    lineLower.includes("d to save") ||
    lineLower.includes("all strips read") ||
    lineLower.includes("all patches read") ||
    lineLower.includes("done reading")
  ) {
    return {
      state: STATE.ALL_STRIPS_READ,
      prompt: lineTrim,
      matched: true,
    };
  }

  // 7. Warning prompts (e.g. unexpected response, use it anyway)
  if (
    lineLower.includes("(warning)") ||
    lineLower.includes("use it anyway") ||
    lineLower.includes("seem to have read strip pass") ||
    lineLower.includes("unexpected response")
  ) {
    return {
      state: STATE.WARNING,
      prompt: lineTrim,
      matched: true,
    };
  }

  // 8. Calibration prompts
  if (
    ((lineLower.includes("place") &&
      (lineLower.includes("reference") ||
       lineLower.includes("white") ||
       lineLower.includes("calibrat") ||
       lineLower.includes("standard"))) ||
     lineLower.includes("hit any key to continue") ||
     lineLower.includes("calibration")) &&
    !lineLower.includes("place sheet") &&
    !lineLower.includes("locate patch")
  ) {
    return {
      state: STATE.CALIBRATING,
      prompt: lineTrim,
      matched: true,
    };
  }

  // 9. Ready to read / Strip trigger (handheld / strip readers)
  if (
    ((lineLower.includes("hit") && lineLower.includes("read") && lineLower.includes("strip")) ||
     lineLower.includes("ready to read") ||
     (lineLower.includes("read") && lineLower.includes("strip") && lineLower.includes("key"))) &&
    !lineLower.includes("all strips read")
  ) {
    return {
      state: STATE.AWAITING_STRIP,
      prompt: lineTrim,
      matched: true,
    };
  }

  // 10. Reading / Scanning
  if (
    lineLower.includes("reading strip") ||
    lineLower.includes("processing") ||
    lineLower.includes("scanning") ||
    lineLower.includes("reading sheet")
  ) {
    return {
      state: STATE.READING,
      prompt: lineTrim,
      matched: true,
    };
  }

  // 11. Errors
  if (
    lineLower.includes("error") ||
    lineLower.includes("too fast") ||
    lineLower.includes("too slow") ||
    lineLower.includes("misread") ||
    lineLower.includes("failed to read")
  ) {
    return {
      state: STATE.ERROR,
      prompt: lineTrim,
      matched: true,
    };
  }

  return {
    state: currentState,
    prompt: lineTrim,
    matched: false,
  };
}

let currentState = STATE.IDLE;
let currentProcessId = "";
let measurementInProgress = false;
let xyTableDetected = false;
let currentPassIndex = 0;
const recordedPasses = [];

export function initChartread() {
  const btnStartRead = document.getElementById("btnStartRead");
  const btnCalibrate = document.getElementById("btnCalibrate");
  const btnDoneRead = document.getElementById("btnDoneRead");
  const btnAccept = document.getElementById("btnAccept");
  const btnRetry = document.getElementById("btnRetry");
  const btnUndo = document.getElementById("btnUndo");
  const btnSkip = document.getElementById("btnSkip");
  const btnCancel = document.getElementById("btnCancel");
  const btnDetectInstruments = document.getElementById("btnDetectInstruments");
  const instrumentSelect = document.getElementById("chartreadInstrumentSelect");
  const promptText = document.getElementById("chartreadPrompt");
  const stateLabel = document.getElementById("chartreadState");
  const logContainer = document.getElementById("chartreadLogContainer");
  const logPre = document.getElementById("chartreadLog");
  const averagingPanel = document.getElementById("chartreadAveragingPanel");
  const passesList = document.getElementById("passesList");
  const passCounterBadge = document.getElementById("passCounterBadge");
  const btnMeasureAnotherSheet = document.getElementById("btnMeasureAnotherSheet");
  const btnFinishAndAverage = document.getElementById("btnFinishAndAverage");
  const xyTableHint = document.getElementById("xyTableHint");
  const xyTablePanel = document.getElementById("xyTablePanel");
  const xyTableActiveStepBadge = document.getElementById("xyTableActiveStepBadge");
  const xyStepPlace = document.getElementById("xyStepPlace");
  const xyStepAlign = document.getElementById("xyStepAlign");
  const xyStepScan = document.getElementById("xyStepScan");
  const xyStepRemove = document.getElementById("xyStepRemove");

  function setXyTableVisible(visible) {
    if (xyTableHint) {
      if (visible) xyTableHint.classList.remove("hidden");
      else xyTableHint.classList.add("hidden");
    }
    if (xyTablePanel) {
      if (visible) xyTablePanel.classList.remove("hidden");
      else xyTablePanel.classList.add("hidden");
    }
  }

  function updateXyTableSequence(phase) {
    if (!xyTablePanel) return;

    const steps = [
      { el: xyStepPlace, name: "place" },
      { el: xyStepAlign, name: "align" },
      { el: xyStepScan, name: "scan" },
      { el: xyStepRemove, name: "remove" },
    ];

    const phaseOrder = ["place", "align", "scan", "remove", "done"];
    const targetIndex = phaseOrder.indexOf(phase);

    steps.forEach((step, idx) => {
      if (!step.el) return;
      step.el.classList.remove("active", "completed");
      if (targetIndex >= 0) {
        if (idx < targetIndex) {
          step.el.classList.add("completed");
        } else if (idx === targetIndex && phase !== "done") {
          step.el.classList.add("active");
        } else if (phase === "done") {
          step.el.classList.add("completed");
        }
      }
    });

    if (xyTableActiveStepBadge) {
      xyTableActiveStepBadge.className = "status-badge";
      switch (phase) {
        case "place":
          xyTableActiveStepBadge.textContent = "Step 1: Place Sheet";
          xyTableActiveStepBadge.classList.add("badge-primary");
          break;
        case "align":
          xyTableActiveStepBadge.textContent = "Step 2: Align Patches";
          xyTableActiveStepBadge.classList.add("badge-primary");
          break;
        case "scan":
          xyTableActiveStepBadge.textContent = "Step 3: Scanning";
          xyTableActiveStepBadge.classList.add("badge-primary");
          break;
        case "remove":
          xyTableActiveStepBadge.textContent = "Step 4: Remove Sheet";
          xyTableActiveStepBadge.classList.add("badge-primary");
          break;
        case "done":
          xyTableActiveStepBadge.textContent = "Complete";
          xyTableActiveStepBadge.classList.add("badge-good");
          break;
        default:
          xyTableActiveStepBadge.textContent = "Standby";
          xyTableActiveStepBadge.classList.add("badge-idle");
          break;
      }
    }
  }

  function setMeasurementBusy(busy) {
    measurementInProgress = busy;
    if (btnStartRead) btnStartRead.disabled = busy;
    if (btnMeasureAnotherSheet) btnMeasureAnotherSheet.disabled = busy;
    if (btnFinishAndAverage) {
      btnFinishAndAverage.disabled = busy || recordedPasses.length === 0;
    }
  }

  function renderPassesList() {
    if (!passesList) return;
    passesList.innerHTML = "";
    recordedPasses.forEach((pass, i) => {
      const item = document.createElement("div");
      item.style.cssText = "display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.05); padding:6px 10px; border-radius:4px; font-size:0.85rem;";
      const label = document.createElement("span");
      const strong = document.createElement("strong");
      strong.textContent = `Sheet Pass #${i + 1}`;
      label.appendChild(strong);
      label.appendChild(document.createTextNode(` (${pass.filename})`));
      const time = document.createElement("span");
      time.style.opacity = "0.7";
      time.textContent = `✓ ${pass.time}`;
      item.appendChild(label);
      item.appendChild(time);
      passesList.appendChild(item);
    });
  }

  function acceptStage3(basename, cwd) {
    wizardState.setTarget(basename, cwd);
    setStage3Result(basename, cwd);
    wizardState.updateGating();
    advanceToStage4();
  }

  // Instrument detection logic
  if (btnDetectInstruments && instrumentSelect) {
    btnDetectInstruments.addEventListener("click", async () => {
      btnDetectInstruments.disabled = true;
      btnDetectInstruments.textContent = "Detecting...";
      setPrompt("Querying connected spectrophotometers and colorimeters via instlist...");

      let stdoutAccumulator = "";
      const regexDetected = [];

      try {
        const unlistenStdout = await listen("process:stdout", (event) => {
          if (event.payload.id !== "instlist" || !event.payload.line) return;
          const line = event.payload.line;
          stdoutAccumulator += line + "\n";

          // Legacy regex line matching fallback
          const KNOWN_INST_TOKENS = /i1|ColorMunki|Spyder|spectro|Display|Huey|DTP|SpectroScan|Smile|Klein/i;
          const match = line.trim().match(/^(\d+)[\s:=]+'?([^'\n]+)'?(?:\s+on\s+'?([^'\n]+)'?)?/i);
          if (match) {
            const index = match[1];
            const name = match[2].trim();
            const port = match[3] ? match[3].trim() : "";
            if (KNOWN_INST_TOKENS.test(name) || port.length > 0) {
              regexDetected.push({ index, name, port });
            }
          }
        });

        const unlistenExit = await listen("process:exit", (event) => {
          if (event.payload.id !== "instlist") return;
          unlistenStdout();
          unlistenExit();
          btnDetectInstruments.disabled = false;
          btnDetectInstruments.textContent = "↺ Detect";

          instrumentSelect.innerHTML = `<option value="">Auto (First available port)</option>`;

          let devicesList = [];

          // Try parsing JSON output from instlist
          try {
            const trimmed = stdoutAccumulator.trim();
            const parsed = JSON.parse(trimmed);
            if (parsed && Array.isArray(parsed.devices)) {
              devicesList = parsed.devices.map(d => ({
                index: String(d.port || ""),
                name: d.name || d.type || "Instrument",
                type: d.type || "",
                port: String(d.port || ""),
              }));
            }
          } catch (_) {
            // Fall back to regex parsed items if not JSON
            devicesList = regexDetected;
          }

          if (devicesList.length > 0) {
            devicesList.forEach((inst) => {
              const opt = document.createElement("option");
              // Port value for -c switch. If port is 1 or auto, empty string leaves -c omitted for default port
              opt.value = inst.port && inst.port !== "1" ? inst.port : "";
              const isXy = /spectro\s?scan|i1io/i.test(inst.name) || /spectro\s?scan|i1io/i.test(inst.type);
              if (isXy) {
                opt.dataset.xy = "1";
                opt.textContent = `${inst.type || inst.name}${inst.port ? ` (Port ${inst.port})` : ""} · XY Table`;
              } else {
                opt.textContent = `${inst.type || inst.name}${inst.port ? ` (Port ${inst.port})` : ""}`;
              }
              instrumentSelect.appendChild(opt);
            });
            instrumentSelect.value = "";
            setPrompt(`Found ${devicesList.length} instrument(s): ${devicesList.map(d => d.type || d.name).join(", ")}`);
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

  if (instrumentSelect) {
    instrumentSelect.addEventListener("change", () => {
      const selectedOpt = instrumentSelect.selectedOptions && instrumentSelect.selectedOptions[0];
      const isXy = Boolean(selectedOpt && selectedOpt.dataset && selectedOpt.dataset.xy === "1");
      if (isXy) {
        xyTableDetected = true;
        setXyTableVisible(true);
        updateXyTableSequence("standby");
      } else if (!measurementInProgress) {
        xyTableDetected = false;
        setXyTableVisible(false);
      }
    });
  }

  function setState(newState) {
    currentState = newState;
    if (stateLabel) stateLabel.textContent = newState;

    // Show/hide buttons based on state
    if (btnCalibrate) btnCalibrate.classList.add("hidden");
    if (btnDoneRead) btnDoneRead.classList.add("hidden");
    if (btnAccept) btnAccept.classList.add("hidden");
    if (btnRetry) btnRetry.classList.add("hidden");
    if (btnUndo) btnUndo.classList.add("hidden");
    if (btnSkip) btnSkip.classList.add("hidden");
    if (btnCancel) btnCancel.classList.add("hidden");
    if (btnStartRead) btnStartRead.classList.add("hidden");

    switch (newState) {
      case STATE.IDLE:
        if (btnStartRead) btnStartRead.classList.remove("hidden");
        break;
      case STATE.CALIBRATING:
        if (btnCalibrate) {
          btnCalibrate.disabled = false;
          btnCalibrate.textContent = "✓ Calibrate";
          btnCalibrate.classList.remove("hidden");
        }
        if (btnCancel) btnCancel.classList.remove("hidden");
        break;
      case STATE.AWAITING_STRIP:
        if (btnRetry) {
          btnRetry.disabled = false;
          btnRetry.textContent = "↻ Retry Strip";
          btnRetry.classList.remove("hidden");
        }
        if (btnUndo) {
          btnUndo.disabled = false;
          btnUndo.classList.remove("hidden");
        }
        if (btnSkip) btnSkip.classList.remove("hidden");
        if (btnDoneRead) {
          btnDoneRead.disabled = false;
          btnDoneRead.textContent = "💾 Done & Save .ti3";
          btnDoneRead.classList.remove("hidden");
        }
        if (btnCancel) btnCancel.classList.remove("hidden");
        break;
      case STATE.READING:
        if (btnCancel) btnCancel.classList.remove("hidden");
        break;
      case STATE.ALL_STRIPS_READ:
        if (btnDoneRead) {
          btnDoneRead.disabled = false;
          btnDoneRead.textContent = "💾 Done & Save .ti3";
          btnDoneRead.classList.remove("hidden");
        }
        if (btnRetry) {
          btnRetry.disabled = false;
          btnRetry.textContent = "↻ Re-read Last Strip";
          btnRetry.classList.remove("hidden");
        }
        if (btnUndo) {
          btnUndo.disabled = false;
          btnUndo.classList.remove("hidden");
        }
        if (btnCancel) btnCancel.classList.remove("hidden");
        break;
      case STATE.WARNING:
        if (btnAccept) {
          btnAccept.disabled = false;
          btnAccept.textContent = "✓ Accept Strip";
          btnAccept.classList.remove("hidden");
        }
        if (btnRetry) {
          btnRetry.disabled = false;
          btnRetry.textContent = "↻ Retry Strip";
          btnRetry.classList.remove("hidden");
        }
        if (btnCancel) btnCancel.classList.remove("hidden");
        break;
      case STATE.PROMPT_CONTINUE:
        if (btnAccept) {
          btnAccept.disabled = false;
          btnAccept.textContent = "✓ Continue";
          btnAccept.classList.remove("hidden");
        }
        if (btnCancel) btnCancel.classList.remove("hidden");
        break;
      case STATE.TABLE_PLACE_SHEET:
        if (btnAccept) {
          btnAccept.disabled = false;
          btnAccept.textContent = "✓ Sheet Placed — Continue";
          btnAccept.classList.remove("hidden");
        }
        if (btnCancel) btnCancel.classList.remove("hidden");
        break;
      case STATE.TABLE_ALIGN:
        if (btnAccept) {
          btnAccept.disabled = false;
          btnAccept.textContent = "✓ Aligned — Continue";
          btnAccept.classList.remove("hidden");
        }
        if (btnCancel) btnCancel.classList.remove("hidden");
        break;
      case STATE.ERROR:
        if (btnRetry) {
          btnRetry.disabled = false;
          btnRetry.textContent = "↻ Retry Strip";
          btnRetry.classList.remove("hidden");
        }
        if (btnUndo) {
          btnUndo.disabled = false;
          btnUndo.classList.remove("hidden");
        }
        if (btnSkip) btnSkip.classList.remove("hidden");
        if (btnCancel) btnCancel.classList.remove("hidden");
        break;
      case STATE.FINISHED:
        // After a recorded pass, further sheets go through "Measure Another Sheet"
        if (recordedPasses.length === 0) {
          if (btnStartRead) btnStartRead.classList.remove("hidden");
        }
        break;
    }
  }

  function setPrompt(text) {
    if (promptText) promptText.textContent = text;
  }

  // Start reading button
  if (btnStartRead) {
    btnStartRead.addEventListener("click", async () => {
      if (measurementInProgress) {
        setPrompt("A measurement is already running. Wait for it to finish.");
        return;
      }

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
      setMeasurementBusy(true);
      setState(STATE.CALIBRATING);
      setPrompt("Starting chartread... waiting for instrument calibration prompt.");

      const selectedOpt = instrumentSelect && instrumentSelect.selectedOptions && instrumentSelect.selectedOptions[0];
      if (selectedOpt && selectedOpt.dataset && selectedOpt.dataset.xy === "1") {
        xyTableDetected = true;
        setXyTableVisible(true);
        updateXyTableSequence("standby");
      } else {
        xyTableDetected = false;
      }

      const selectedPort = instrumentSelect && instrumentSelect.value ? instrumentSelect.value : null;

      const config = {
        basename: basename,
        cwd: cwd,
        port: selectedPort,
      };

      currentProcessId = `chartread_${basename}`;

      // Start swatch grid listener with completion callback
      await startSwatchListener(currentProcessId, ({ rowIndex, totalRows, rowId, isAllComplete }) => {
        if (isAllComplete && currentState !== STATE.FINISHED) {
          setState(STATE.ALL_STRIPS_READ);
          setPrompt(`🎉 All ${totalRows} strips measured! Click 'Done & Save .ti3' to write measurements and finish.`);
        }
      });

      try {
        const unlistenStdout = await listen("process:stdout", (event) => {
          if (event.payload.id !== currentProcessId || !event.payload.line) return;
          const line = event.payload.line;

          logPre.textContent += line + "\n";
          logPre.scrollTop = logPre.scrollHeight;

          const classified = classifyChartreadLine(line, currentState);

          if (classified.matched) {
            if (
              classified.state === STATE.TABLE_PLACE_SHEET ||
              classified.state === STATE.TABLE_ALIGN ||
              (classified.meta && (classified.meta.isRemoveSheetNotice || classified.meta.sheetOk))
            ) {
              if (!xyTableDetected) {
                xyTableDetected = true;
                setXyTableVisible(true);
              }
            }

            if (xyTableDetected) {
              if (classified.state === STATE.TABLE_PLACE_SHEET) {
                updateXyTableSequence("place");
              } else if (classified.state === STATE.TABLE_ALIGN) {
                updateXyTableSequence("align");
              } else if (classified.state === STATE.READING) {
                updateXyTableSequence("scan");
              } else if (classified.meta && classified.meta.isRemoveSheetNotice) {
                updateXyTableSequence("remove");
              }
            }

            if (classified.state !== currentState) {
              setState(classified.state);
            }

            if (classified.state === STATE.TABLE_PLACE_SHEET) {
              const sheetInfo = (classified.meta && classified.meta.sheet && classified.meta.totalSheets)
                ? ` (Sheet ${classified.meta.sheet} of ${classified.meta.totalSheets})`
                : "";
              setPrompt(`📋 ${classified.prompt}${sheetInfo}`);
            } else if (classified.state === STATE.TABLE_ALIGN) {
              const patchInfo = (classified.meta && classified.meta.patch)
                ? ` [Patch ${classified.meta.patch}]`
                : "";
              setPrompt(`🎯 ${classified.prompt}${patchInfo}`);
            } else if (classified.meta && classified.meta.isRemoveSheetNotice) {
              setPrompt(`ℹ️ ${classified.prompt}`);
            } else if (classified.meta && classified.meta.sheetOk) {
              setPrompt(`✅ ${classified.prompt}`);
            } else if (classified.state === STATE.ALL_STRIPS_READ) {
              setPrompt(`🎉 ${classified.prompt} — Click 'Done & Save .ti3' to save.`);
            } else if (classified.state === STATE.WARNING) {
              const previousPrompt = promptText ? promptText.textContent.trim() : "";
              const lineLower = line.toLowerCase();
              const isContinuationPrompt = lineLower.includes("hit return to use it anyway") || lineLower.includes("use it anyway");
              if (currentState === STATE.WARNING && isContinuationPrompt && previousPrompt && !previousPrompt.includes(line.trim())) {
                setPrompt(`${previousPrompt}\n${line.trim()}`);
              } else {
                setPrompt(classified.prompt);
              }
            } else if (classified.state === STATE.ERROR) {
              setPrompt("⚠️ " + classified.prompt);
            } else {
              setPrompt(classified.prompt);
            }
          }
        });

        let lastStderrLine = "";

        const unlistenStderr = await listen("process:stderr", (event) => {
          if (event.payload.id === currentProcessId && event.payload.line) {
            lastStderrLine = event.payload.line;
            logPre.textContent += "ERR: " + event.payload.line + "\n";
            logPre.scrollTop = logPre.scrollHeight;
          }
        });

        const unlistenExit = await listen("process:exit", async (event) => {
          if (event.payload.id !== currentProcessId) return;
          unlistenStdout();
          unlistenStderr();
          unlistenExit();
          stopSwatchListener();

          if (event.payload.code === 0) {
            if (xyTableDetected) {
              updateXyTableSequence("done");
            }
            try {
              const passIndex = currentPassIndex + 1;
              const filename = await invoke("snapshot_ti3", {
                cwd: cwd,
                basename: basename,
                passIndex: passIndex,
              });

              currentPassIndex = passIndex;
              recordedPasses.push({
                index: currentPassIndex,
                filename: filename,
                time: new Date().toLocaleTimeString(),
              });

              setState(STATE.FINISHED);
              setPrompt(`Sheet pass #${currentPassIndex} saved as ${filename}. Stage 4 stays locked until you finish.`);
              logPre.textContent += `\n[SUCCESS] chartread completed. Snapshotted ${filename} (canonical ${basename}.ti3 removed until Finish).\n`;

              renderPassesList();
              if (averagingPanel) averagingPanel.classList.remove("hidden");
              if (passCounterBadge) passCounterBadge.textContent = `${recordedPasses.length} Pass(es) Recorded`;
              // Do not call setStage3Result / wizardState.setTarget here (#110)
            } catch (snapErr) {
              setState(STATE.FINISHED);
              setPrompt(`Measurement finished but pass snapshot failed: ${snapErr}`);
              logPre.textContent += `\n[ERROR] snapshot_ti3 failed: ${snapErr}\n`;
            }
          } else {
            setState(STATE.FINISHED);
            if (logContainer) logContainer.open = true;
            const errDetail = lastStderrLine ? ` (${lastStderrLine})` : "";
            setPrompt(`❌ chartread exited with code ${event.payload.code}.${errDetail}`);
            logPre.textContent += `\n[ERROR] chartread exited with code ${event.payload.code}.${errDetail}\n`;
          }

          setMeasurementBusy(false);
        });

        await invoke("run_chartread", { config });

      } catch (err) {
        setPrompt(`Invoke error: ${err}`);
        setState(STATE.IDLE);
        setMeasurementBusy(false);
      }
    });
  }

  if (btnMeasureAnotherSheet) {
    btnMeasureAnotherSheet.addEventListener("click", () => {
      if (measurementInProgress) {
        setPrompt("Wait for the current measurement to finish and be snapshotted.");
        return;
      }
      setState(STATE.IDLE);
      setPrompt(`Ready to measure sheet pass #${recordedPasses.length + 1}. Starting chartread...`);
      if (btnStartRead) btnStartRead.click();
    });
  }

  if (btnFinishAndAverage) {
    btnFinishAndAverage.addEventListener("click", async () => {
      const basename = stage2Basename || wizardState.basename;
      const cwd = stage2Cwd || wizardState.cwd;

      if (!basename || !cwd) {
        setPrompt("Error: No working directory or basename.");
        return;
      }

      if (measurementInProgress) {
        setPrompt("Wait for the current measurement to finish.");
        return;
      }

      if (recordedPasses.length === 0) {
        setPrompt("No measurement passes recorded yet.");
        return;
      }

      if (recordedPasses.length === 1) {
        setPrompt("Single pass accepted. Restoring canonical .ti3 and proceeding to Stage 4...");
        btnFinishAndAverage.disabled = true;
        try {
          await invoke("promote_ti3", {
            cwd: cwd,
            source: recordedPasses[0].filename,
            basename: basename,
          });
          logPre.textContent += `\n[SUCCESS] Promoted ${recordedPasses[0].filename} → ${basename}.ti3 (single pass, average not invoked).\n`;
          setStage3Result(basename, cwd);
          advanceToStage4();
        } catch (e) {
          btnFinishAndAverage.disabled = false;
          setPrompt(`Failed to restore ${basename}.ti3: ${e}`);
        }
        return;
      }

      setPrompt("Averaging measurement passes with Argyll average utility...");
      btnFinishAndAverage.disabled = true;

      try {
        const averageConfig = {
          inputs: recordedPasses.map(p => p.filename),
          output: `${basename}.ti3`,
          cwd: cwd,
        };

        logPre.textContent += `\n[average] average -v ${averageConfig.inputs.join(" ")} ${averageConfig.output}\n`;

        const unlistenAvgExit = await listen("process:exit", async (event) => {
          if (event.payload.id !== `average_${basename}.ti3`) return;
          unlistenAvgExit();

          if (event.payload.code === 0) {
            setPrompt(`✅ Successfully averaged ${recordedPasses.length} measurement passes into ${basename}.ti3!`);
            logPre.textContent += `\n[SUCCESS] average wrote ${basename}.ti3\n`;
            setStage3Result(basename, cwd);
            advanceToStage4();
          } else {
            setPrompt(`⚠️ Argyll average exited with code ${event.payload.code}. Promoting pass 1 as fallback.`);
            logPre.textContent += `\n[ERROR] average exited ${event.payload.code}. Promoting ${recordedPasses[0].filename}.\n`;
            try {
              await invoke("promote_ti3", {
                cwd: cwd,
                source: recordedPasses[0].filename,
                basename: basename,
              });
              setStage3Result(basename, cwd);
              advanceToStage4();
            } catch (e) {
              btnFinishAndAverage.disabled = false;
              setPrompt(`Average failed and fallback promote failed: ${e}`);
            }
          }
        });

        await invoke("run_average", { config: averageConfig });
      } catch (e) {
        console.error("run_average error:", e);
        btnFinishAndAverage.disabled = false;
        setPrompt(`run_average error: ${e}`);
      }
    });
  }

  // Calibrate / confirm button — sends space + newline
  if (btnCalibrate) {
    btnCalibrate.addEventListener("click", async () => {
      try {
        btnCalibrate.disabled = true;
        btnCalibrate.textContent = "⏳ Calibrating...";
        setPrompt("Sending calibration command to instrument...");
        await invoke("send_stdin", { id: currentProcessId, input: " \n" });
      } catch (e) {
        console.error("send_stdin error:", e);
        btnCalibrate.disabled = false;
        btnCalibrate.textContent = "✓ Calibrate";
        setPrompt(`Failed to send calibration signal: ${e}`);
      }
    });
  }

  // Accept / Continue button — sends newline ("\n")
  if (btnAccept) {
    btnAccept.addEventListener("click", async () => {
      try {
        btnAccept.disabled = true;
        await invoke("send_stdin", { id: currentProcessId, input: "\n" });
        if (currentState === STATE.TABLE_PLACE_SHEET || currentState === STATE.TABLE_ALIGN) {
          setPrompt("Continuing XY table sequence...");
        } else {
          setState(STATE.READING);
          setPrompt("Accepted. Processing...");
        }
      } catch (e) {
        console.error("send_stdin error:", e);
        btnAccept.disabled = false;
        setPrompt(`Failed to send accept signal: ${e}`);
      }
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

  // Done & Save button — sends "d\n"
  if (btnDoneRead) {
    btnDoneRead.addEventListener("click", async () => {
      try {
        btnDoneRead.disabled = true;
        btnDoneRead.textContent = "⏳ Saving .ti3...";
        setPrompt("Saving measurement data to .ti3 (sending done signal to chartread)...");
        await invoke("send_stdin", { id: currentProcessId, input: "d\n" });
      } catch (e) {
        console.error("send_stdin error for done:", e);
        btnDoneRead.disabled = false;
        btnDoneRead.textContent = "💾 Done & Save .ti3";
        setPrompt(`Failed to send done signal: ${e}`);
      }
    });
  }

  // Undo button — sends "u\n"
  if (btnUndo) {
    btnUndo.addEventListener("click", async () => {
      try {
        await invoke("send_stdin", { id: currentProcessId, input: "u\n" });
        setState(STATE.READING);
        setPrompt("Undoing previous strip measurement. Preparing to re-read...");
      } catch (e) {
        console.error("send_stdin error for undo:", e);
        setPrompt(`Failed to send undo signal: ${e}`);
      }
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
        btnCancel.disabled = true;
        if (currentState === STATE.TABLE_PLACE_SHEET || currentState === STATE.TABLE_ALIGN || xyTableDetected) {
          // For XY table states, send 'q\n' first to allow the table to park its measurement head gracefully
          try {
            await invoke("send_stdin", { id: currentProcessId, input: "q\n" });
          } catch (_) {}
          // Brief pause before kill to allow graceful parking
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        await invoke("kill_process", { id: currentProcessId });
        stopSwatchListener();
        setState(recordedPasses.length > 0 ? STATE.FINISHED : STATE.IDLE);
        setPrompt("Measurement cancelled.");
        if (xyTableDetected) {
          updateXyTableSequence("standby");
        }
      } catch (e) {
        console.error("kill_process error:", e);
        setPrompt(`Cancel failed: ${e}`);
      } finally {
        btnCancel.disabled = false;
        setMeasurementBusy(false);
        stopSwatchListener();
      }
    });
  }

  // Start in IDLE state
  setState(STATE.IDLE);
  setPrompt("Press 'Start Measurement' to begin reading the printed target.");
}

function advanceToStage4() {
  wizardState.navigateToStage(4);
}
