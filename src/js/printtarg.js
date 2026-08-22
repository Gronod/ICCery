const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// Module-level state: set by Stage 1 when it completes
let stage1Basename = "";
let stage1Cwd = "";

/**
 * Called by targen.js (or app.js) after Stage 1 completes.
 * Passes the basename and working directory forward.
 */
export function setStage1Result(basename, cwd) {
  stage1Basename = basename;
  stage1Cwd = cwd;
}

export function initPrinttarg() {
  const instrumentSelect = document.getElementById("instrumentSelect");
  const pageSizeSelect = document.getElementById("pageSizeSelect");
  const customPageSizeRow = document.getElementById("customPageSizeRow");
  const customPageW = document.getElementById("customPageW");
  const customPageH = document.getElementById("customPageH");
  const bitDepthRadios = document.querySelectorAll('input[name="bitDepth"]');
  const tiffDpi = document.getElementById("tiffDpi");
  const btnCreateLayout = document.getElementById("btnCreateLayout");
  const logContainer = document.getElementById("printtargLogContainer");
  const logPre = document.getElementById("printtargLog");
  const tiffGallery = document.getElementById("tiffGallery");
  const galleryInfo = document.getElementById("galleryInfo");
  const galleryGrid = document.getElementById("galleryGrid");

  // Show/hide custom page size inputs
  pageSizeSelect.addEventListener("change", (e) => {
    if (e.target.value === "custom") {
      customPageSizeRow.classList.remove("hidden");
    } else {
      customPageSizeRow.classList.add("hidden");
    }
  });

  // Create Layout button
  btnCreateLayout.addEventListener("click", async () => {
    // Validate that Stage 1 has been completed
    if (!stage1Basename) {
      logPre.textContent = "[ERROR] No .ti1 file available. Complete Stage 1 first.\n";
      logContainer.classList.remove("hidden");
      return;
    }

    logPre.textContent = "";
    logContainer.classList.remove("hidden");
    tiffGallery.classList.add("hidden");
    galleryGrid.innerHTML = "";
    btnCreateLayout.disabled = true;

    // Determine page size
    let pageSize = pageSizeSelect.value;
    if (pageSize === "custom") {
      const w = parseInt(customPageW.value, 10);
      const h = parseInt(customPageH.value, 10);
      if (!w || !h || w < 50 || h < 50) {
        logPre.textContent = "[ERROR] Custom page size must have width and height ≥ 50mm.\n";
        btnCreateLayout.disabled = false;
        return;
      }
      pageSize = `${w}x${h}`;
    }

    // Determine bit depth
    let bitDepth = 8;
    bitDepthRadios.forEach(radio => {
      if (radio.checked) bitDepth = parseInt(radio.value, 10);
    });

    const config = {
      instrument: instrumentSelect.value,
      page_size: pageSize,
      bit_depth: bitDepth,
      dpi: parseInt(tiffDpi.value, 10),
      basename: stage1Basename,
      cwd: stage1Cwd,
    };

    const processId = `printtarg_${stage1Basename}`;

    // Accumulate all stdout lines to extract JSON manifest at the end
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

      const unlistenExit = await listen("process:exit", (event) => {
        if (event.payload.id === processId) {
          unlistenStdout();
          unlistenStderr();
          unlistenExit();

          if (event.payload.code === 0) {
            logPre.textContent += "\n[SUCCESS] printtarg completed successfully.\n";
            btnCreateLayout.disabled = false;

            // Parse the JSON manifest from stdout
            const manifest = extractManifest(stdoutAccumulator);
            if (manifest && manifest.pages && manifest.pages.length > 0) {
              renderTiffGallery(manifest, config.cwd);
            }

            advanceToStage3();
          } else {
            logPre.textContent += `\n[ERROR] printtarg exited with code ${event.payload.code}.\n`;
            btnCreateLayout.disabled = false;
          }
        }
      });

      logPre.textContent = "Starting printtarg...\n";
      await invoke("run_printtarg", { config });

    } catch (err) {
      logPre.textContent += `\n[INVOKE ERROR] ${err}\n`;
      btnCreateLayout.disabled = false;
    }
  });

  /**
   * Extract the JSON manifest object from the accumulated stdout.
   * The manifest is emitted by printtarg -u as a JSON block starting with { and ending with }.
   * It always appears at the end of stdout, after all "Creating file..." lines.
   */
  function extractManifest(stdout) {
    try {
      // Find the last JSON object in the output
      const jsonStart = stdout.lastIndexOf('{\n  "event": "manifest"');
      if (jsonStart === -1) return null;
      const jsonEnd = stdout.indexOf('\n}', jsonStart);
      if (jsonEnd === -1) return null;
      const jsonStr = stdout.substring(jsonStart, jsonEnd + 2);
      return JSON.parse(jsonStr);
    } catch (e) {
      console.error("Failed to parse printtarg manifest:", e);
      return null;
    }
  }

  /**
   * Render TIFF preview gallery using base64-encoded images from the backend.
   * @param {Object} manifest - The parsed JSON manifest from printtarg -u
   * @param {string} cwd - The working directory where TIFFs were generated
   */
  async function renderTiffGallery(manifest, cwd) {
    tiffGallery.classList.remove("hidden");

    const pageCount = manifest.pages.length;
    const totalPatches = manifest.pages.reduce((sum, p) => sum + p.patches, 0);
    const dims = manifest.pages[0];
    galleryInfo.textContent = `${pageCount} page(s) · ${totalPatches} patches · ${dims.width_mm} × ${dims.height_mm} mm per page`;

    for (const page of manifest.pages) {
      const sep = cwd.includes('\\') ? '\\' : '/';
      const filePath = cwd ? `${cwd}${sep}${page.filename}` : page.filename;

      const card = document.createElement("div");
      card.className = "gallery-card";

      const label = document.createElement("div");
      label.className = "gallery-label";
      label.textContent = `${page.filename} (${page.patches} patches)`;
      card.appendChild(label);

      try {
        const base64Data = await invoke("read_file_base64", { path: filePath });
        const img = document.createElement("img");
        img.src = `data:image/tiff;base64,${base64Data}`;
        img.alt = page.filename;
        // TIFF may not render natively in all browsers — provide a fallback
        img.onerror = () => {
          img.remove();
          const fallback = document.createElement("div");
          fallback.className = "gallery-fallback";
          fallback.innerHTML = `<span class="file-icon">📄</span><span>${page.filename}</span><span class="file-size">${page.patches} patches</span>`;
          card.insertBefore(fallback, label.nextSibling);
        };
        card.appendChild(img);
      } catch (err) {
        const fallback = document.createElement("div");
        fallback.className = "gallery-fallback";
        fallback.innerHTML = `<span class="file-icon">📄</span><span>${page.filename}</span><span class="file-size">Preview unavailable</span>`;
        card.appendChild(fallback);
      }

      galleryGrid.appendChild(card);
    }
  }
}

function advanceToStage3() {
  const steps = document.querySelectorAll('.step');
  const stages = document.querySelectorAll('.stage');

  steps.forEach(s => s.classList.remove('active'));
  if (steps[2]) steps[2].classList.add('active');

  stages.forEach(s => {
    s.classList.remove('active');
    s.classList.add('hidden');
  });
  if (stages[2]) {
    stages[2].classList.remove('hidden');
    stages[2].classList.add('active');
  }
}
