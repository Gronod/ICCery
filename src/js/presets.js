const { invoke } = window.__TAURI__.core;

let currentPresets = [];
let activePresetId = "preset-std-rgb";

export async function initPresets() {
  const presetSelect = document.getElementById("presetSelect");
  const btnSavePresetModal = document.getElementById("btnSavePresetModal");
  const btnOpenPresetsDialog = document.getElementById("btnOpenPresetsDialog");
  const savePresetDialog = document.getElementById("savePresetDialog");
  const btnCloseSavePresetDialog = document.getElementById("btnCloseSavePresetDialog");
  const btnConfirmSavePreset = document.getElementById("btnConfirmSavePreset");
  const savePresetName = document.getElementById("savePresetName");
  const savePresetDesc = document.getElementById("savePresetDesc");
  const managePresetsDialog = document.getElementById("managePresetsDialog");
  const btnCloseManagePresetsDialog = document.getElementById("btnCloseManagePresetsDialog");
  const managePresetsList = document.getElementById("managePresetsList");
  const btnExportActivePreset = document.getElementById("btnExportActivePreset");
  const btnImportPreset = document.getElementById("btnImportPreset");

  async function loadPresets() {
    try {
      currentPresets = await invoke("get_all_presets");
      renderPresetDropdown();
      renderManagePresetsList();
    } catch (err) {
      console.error("Failed to load presets:", err);
    }
  }

  function renderPresetDropdown() {
    if (!presetSelect) return;
    presetSelect.innerHTML = "";

    currentPresets.forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name;
      if (p.id === activePresetId) opt.selected = true;
      presetSelect.appendChild(opt);
    });
  }

  function renderManagePresetsList() {
    if (!managePresetsList) return;
    managePresetsList.innerHTML = "";

    currentPresets.forEach((p) => {
      const isBuiltin = p.id.startsWith("preset-");
      const item = document.createElement("div");
      item.style.cssText = "display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.05); padding:8px 12px; border-radius:6px;";
      
      const leftCol = document.createElement("div");
      leftCol.style.cssText = "flex:1; margin-right:12px;";

      const titleRow = document.createElement("div");
      titleRow.style.cssText = "font-weight:600; font-size:0.9rem; display:flex; align-items:center; gap:6px;";
      const titleSpan = document.createElement("span");
      titleSpan.textContent = p.name || "Untitled";
      titleRow.appendChild(titleSpan);

      if (isBuiltin) {
        const badge = document.createElement("span");
        badge.style.cssText = "font-size:0.7rem; opacity:0.6; border:1px solid #555; padding:1px 4px; border-radius:3px;";
        badge.textContent = "Built-in";
        titleRow.appendChild(badge);
      }
      leftCol.appendChild(titleRow);

      const descDiv = document.createElement("div");
      descDiv.style.cssText = "font-size:0.8rem; opacity:0.75; margin-top:2px;";
      descDiv.textContent = p.description || "No description";
      leftCol.appendChild(descDiv);

      const metaDiv = document.createElement("div");
      metaDiv.style.cssText = "font-size:0.75rem; opacity:0.5; margin-top:4px;";
      metaDiv.textContent = `${(p.colour_space || "").toUpperCase()} • ${p.patch_count} patches • ${p.page_size} • ${p.dpi || 300} DPI • ${p.bit_depth}-bit`;
      leftCol.appendChild(metaDiv);

      item.appendChild(leftCol);

      const actionsDiv = document.createElement("div");
      actionsDiv.style.cssText = "display:flex; gap:6px;";

      const exportBtn = document.createElement("button");
      exportBtn.type = "button";
      exportBtn.className = "icon-btn";
      exportBtn.title = "Export to JSON";
      exportBtn.style.cssText = "font-size:0.85rem; padding:4px 6px; border:1px solid var(--border-color, #333); border-radius:4px; background:transparent; cursor:pointer;";
      exportBtn.textContent = "💾";
      exportBtn.addEventListener("click", () => exportPreset(p));
      actionsDiv.appendChild(exportBtn);

      if (!isBuiltin) {
        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "icon-btn";
        deleteBtn.title = "Delete Preset";
        deleteBtn.style.cssText = "font-size:0.85rem; padding:4px 6px; border:1px solid var(--border-color, #333); border-radius:4px; background:transparent; cursor:pointer; color:#ff6b6b;";
        deleteBtn.textContent = "🗑️";
        deleteBtn.addEventListener("click", async () => {
          if (confirm(`Delete preset "${p.name}"?`)) {
            try {
              currentPresets = await invoke("delete_preset", { id: p.id });
              if (activePresetId === p.id) {
                activePresetId = "preset-std-rgb";
                const fallback = currentPresets.find(x => x.id === activePresetId);
                if (fallback) applyPreset(fallback);
              }
              renderPresetDropdown();
              renderManagePresetsList();
            } catch (err) {
              alert("Delete preset failed: " + err);
            }
          }
        });
        actionsDiv.appendChild(deleteBtn);
      }

      item.appendChild(actionsDiv);
      managePresetsList.appendChild(item);
    });
  }

  function applyPreset(preset) {
    if (!preset) return;
    activePresetId = preset.id;

    // Stage 1 controls
    const csRadios = document.querySelectorAll('input[name="colourSpace"]');
    csRadios.forEach((r) => {
      if (r.value.toLowerCase() === preset.colour_space.toLowerCase()) r.checked = true;
    });

    const patchCountPreset = document.getElementById("patchCountPreset");
    const patchCountCustom = document.getElementById("patchCountCustom");
    if (patchCountPreset && patchCountCustom) {
      const match = Array.from(patchCountPreset.options).find(o => o.value === String(preset.patch_count));
      if (match) {
        patchCountPreset.value = String(preset.patch_count);
        patchCountCustom.classList.add("hidden");
      } else {
        patchCountPreset.value = "custom";
        patchCountCustom.value = preset.patch_count;
        patchCountCustom.classList.remove("hidden");
      }
    }

    const whitePatches = document.getElementById("whitePatches");
    if (whitePatches) whitePatches.value = preset.white_patches !== null && preset.white_patches !== undefined ? preset.white_patches : "";

    const blackPatches = document.getElementById("blackPatches");
    if (blackPatches) blackPatches.value = preset.black_patches !== null && preset.black_patches !== undefined ? preset.black_patches : "";

    // Stage 2 controls
    const instrumentSelect = document.getElementById("instrumentSelect");
    if (instrumentSelect && preset.instrument) instrumentSelect.value = preset.instrument;

    const pageSizeSelect = document.getElementById("pageSizeSelect");
    if (pageSizeSelect && preset.page_size) pageSizeSelect.value = preset.page_size;

    const bitDepthRadios = document.querySelectorAll('input[name="bitDepth"]');
    bitDepthRadios.forEach((r) => {
      if (Number(r.value) === preset.bit_depth) r.checked = true;
    });

    const tiffDpi = document.getElementById("tiffDpi");
    if (tiffDpi && preset.dpi) {
      tiffDpi.value = preset.dpi;
    }

    // Stage 4 controls
    const colprofQuality = document.getElementById("colprofQuality");
    if (colprofQuality && preset.colprof_quality) colprofQuality.value = preset.colprof_quality;

    const colprofAlgorithm = document.getElementById("colprofAlgorithm");
    if (colprofAlgorithm && preset.colprof_algorithm) colprofAlgorithm.value = preset.colprof_algorithm;
  }

  function collectCurrentSettingsAsPreset(name, description) {
    const csRadio = document.querySelector('input[name="colourSpace"]:checked');
    const colour_space = csRadio ? csRadio.value : "rgb";

    const patchCountPreset = document.getElementById("patchCountPreset");
    const patchCountCustom = document.getElementById("patchCountCustom");
    let patch_count = 800;
    if (patchCountPreset) {
      if (patchCountPreset.value === "custom" && patchCountCustom) {
        patch_count = parseInt(patchCountCustom.value, 10) || 800;
      } else {
        patch_count = parseInt(patchCountPreset.value, 10) || 800;
      }
    }

    const whiteInput = document.getElementById("whitePatches");
    const white_patches = whiteInput && whiteInput.value ? parseInt(whiteInput.value, 10) : null;

    const blackInput = document.getElementById("blackPatches");
    const black_patches = blackInput && blackInput.value ? parseInt(blackInput.value, 10) : null;

    const instrumentSelect = document.getElementById("instrumentSelect");
    const instrument = instrumentSelect ? instrumentSelect.value : "i1";

    const pageSizeSelect = document.getElementById("pageSizeSelect");
    const page_size = pageSizeSelect ? pageSizeSelect.value : "A4";

    const bitDepthRadio = document.querySelector('input[name="bitDepth"]:checked');
    const bit_depth = bitDepthRadio ? parseInt(bitDepthRadio.value, 10) : 8;

    const tiffDpi = document.getElementById("tiffDpi");
    const dpi = tiffDpi && tiffDpi.value ? parseInt(tiffDpi.value, 10) || 300 : 300;

    const colprofQuality = document.getElementById("colprofQuality");
    const colprof_quality = colprofQuality ? colprofQuality.value : "m";

    const colprofAlgorithm = document.getElementById("colprofAlgorithm");
    const colprof_algorithm = colprofAlgorithm ? colprofAlgorithm.value : "l";

    return {
      id: `custom-${Date.now()}`,
      name: name || "Custom Preset",
      description: description || null,
      colour_space,
      patch_count,
      white_patches,
      black_patches,
      instrument,
      page_size,
      bit_depth,
      dpi,
      colprof_algorithm,
      colprof_quality,
      colprof_intent: null,
    };
  }

  function exportPreset(preset) {
    try {
      const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(preset, null, 2));
      const downloadAnchor = document.createElement("a");
      downloadAnchor.setAttribute("href", dataStr);
      downloadAnchor.setAttribute("download", `${preset.name.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}.preset.json`);
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      downloadAnchor.remove();
    } catch (err) {
      alert("Export failed: " + err);
    }
  }

  // Dropdown change listener
  if (presetSelect) {
    presetSelect.addEventListener("change", () => {
      const selected = currentPresets.find(p => p.id === presetSelect.value);
      if (selected) applyPreset(selected);
    });
  }

  // Save preset modal triggers
  if (btnSavePresetModal && savePresetDialog) {
    btnSavePresetModal.addEventListener("click", () => {
      if (savePresetName) savePresetName.value = "";
      if (savePresetDesc) savePresetDesc.value = "";
      savePresetDialog.showModal();
    });
  }

  if (btnCloseSavePresetDialog && savePresetDialog) {
    btnCloseSavePresetDialog.addEventListener("click", () => {
      savePresetDialog.close();
    });
  }

  if (btnConfirmSavePreset && savePresetDialog) {
    btnConfirmSavePreset.addEventListener("click", async () => {
      const name = savePresetName ? savePresetName.value.trim() : "";
      if (!name) {
        alert("Please enter a name for your preset.");
        return;
      }
      const desc = savePresetDesc ? savePresetDesc.value.trim() : "";
      const preset = collectCurrentSettingsAsPreset(name, desc);

      try {
        currentPresets = await invoke("save_preset", { preset });
        activePresetId = preset.id;
        renderPresetDropdown();
        renderManagePresetsList();
        savePresetDialog.close();
      } catch (err) {
        alert("Save preset failed: " + err);
      }
    });
  }

  // Manage presets dialog triggers
  if (btnOpenPresetsDialog && managePresetsDialog) {
    btnOpenPresetsDialog.addEventListener("click", () => {
      renderManagePresetsList();
      managePresetsDialog.showModal();
    });
  }

  if (btnCloseManagePresetsDialog && managePresetsDialog) {
    btnCloseManagePresetsDialog.addEventListener("click", () => {
      managePresetsDialog.close();
    });
  }

  if (btnExportActivePreset) {
    btnExportActivePreset.addEventListener("click", () => {
      const preset = currentPresets.find(p => p.id === activePresetId);
      if (preset) exportPreset(preset);
    });
  }

  if (btnImportPreset) {
    btnImportPreset.addEventListener("click", () => {
      const fileInput = document.createElement("input");
      fileInput.type = "file";
      fileInput.accept = ".json";
      fileInput.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async (evt) => {
          try {
            const jsonText = evt.target.result;
            const imported = await invoke("import_preset_json", { json: jsonText });
            imported.id = `custom-${Date.now()}`;
            currentPresets = await invoke("save_preset", { preset: imported });
            activePresetId = imported.id;
            applyPreset(imported);
            renderPresetDropdown();
            renderManagePresetsList();
            alert(`Preset "${imported.name}" imported successfully!`);
          } catch (err) {
            alert("Import failed: " + err);
          }
        };
        reader.readAsText(file);
      };
      fileInput.click();
    });
  }

  // Initial load
  await loadPresets();
  const defaultP = currentPresets.find(p => p.id === "preset-std-rgb");
  if (defaultP) applyPreset(defaultP);
}
