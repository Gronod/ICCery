/**
 * Printer calibration (linearization & ink limits) via printcal / applycal (#224).
 *
 * Optional Stage 0 workflow. The 5-stage wizard is unchanged when calibration
 * is skipped. Curves feed subsequent printtarg (-K) and colprof (applycal).
 */

import { wizardState } from './state.js';
import { logger } from './logger.js';

const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)
  ? window.__TAURI__.core.invoke.bind(window.__TAURI__.core)
  : async () => { throw new Error('Tauri invoke unavailable'); };
const listen = (window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen)
  ? window.__TAURI__.event.listen.bind(window.__TAURI__.event)
  : async () => () => {};

export const CAL_PREFIX = 'CAL_';
export const DEFAULT_STALE_DAYS = 30;
export const CHANNEL_COLORS = {
  C: '#00b4d8',
  M: '#e63980',
  Y: '#f4d35e',
  K: '#c5c5c5',
  R: '#e74c3c',
  G: '#2ecc71',
  B: '#3498db',
};

const calState = {
  status: 'none', // none | active | stale
  calPath: null,
  filename: null,
  created: null,
  applyEnabled: true,
  printerName: null,
  colourSpace: null,
  inkLimits: [],
  totalInkLimit: null,
  curves: [],
  calBasename: null,
  recommendedPower: null,
  ageDays: 0,
  staleDays: DEFAULT_STALE_DAYS,
};

export function makeCalibrationBasename(basename) {
  const trimmed = String(basename || '').trim();
  const base = trimmed.startsWith(CAL_PREFIX) ? trimmed.slice(CAL_PREFIX.length) : trimmed;
  return `${CAL_PREFIX}${base || 'printer'}`;
}

export function isCalibrationBasename(basename) {
  return String(basename || '').trim().startsWith(CAL_PREFIX);
}

export function isCalibrationStale(ageDays, staleDays = DEFAULT_STALE_DAYS) {
  return Number(ageDays) > Math.max(1, Number(staleDays) || DEFAULT_STALE_DAYS);
}

export function totalAreaCoverage(limits) {
  if (!Array.isArray(limits) || limits.length === 0) return 0;
  return limits.reduce((sum, item) => sum + (Number(item.percent) || 0), 0);
}

export function classifyCalibrationStatus({
  calPath,
  applyEnabled,
  ageDays,
  staleDays,
  printerName,
  currentPrinter,
} = {}) {
  if (!calPath) return 'none';
  if (printerName && currentPrinter && printerName !== currentPrinter) return 'stale';
  if (isCalibrationStale(ageDays || 0, staleDays)) return 'stale';
  if (applyEnabled === false) return 'active';
  return 'active';
}

export function downsampleCurve(points, maxPoints = 48) {
  if (!Array.isArray(points) || points.length <= maxPoints) return points || [];
  const out = [];
  const last = points.length - 1;
  for (let i = 0; i < maxPoints; i += 1) {
    const idx = Math.round((i / (maxPoints - 1)) * last);
    out.push(points[idx]);
  }
  return out;
}

export function buildCurvePolyline(points, width = 320, height = 160, padding = 18) {
  const pts = downsampleCurve(points);
  if (!pts.length) return '';
  const innerW = width - padding * 2;
  const innerH = height - padding * 2;
  return pts.map((p, i) => {
    const x = padding + (Number(p[0]) || 0) * innerW;
    const y = padding + innerH - (Number(p[1]) || 0) * innerH;
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}

export function getActiveCalibration() {
  return { ...calState };
}

export function getPrinttargCalibrationFields(basename) {
  if (isCalibrationBasename(basename)) {
    return { calibration_file: null, calibration_embed_only: false };
  }
  if (!calState.applyEnabled || !calState.calPath) {
    return { calibration_file: null, calibration_embed_only: false };
  }
  return { calibration_file: calState.calPath, calibration_embed_only: false };
}

export async function applyCalibrationToProfile(profilePath) {
  if (!calState.applyEnabled || !calState.calPath || !profilePath) return null;
  try {
    const result = await invoke('apply_calibration', {
      config: {
        cal_path: calState.calPath,
        input_path: profilePath,
        output_path: null,
        unapply: false,
      },
    });
    logger.info(`applycal: ${result.message}`, 'Calibration');
    return result;
  } catch (err) {
    logger.error(`applycal failed: ${err}`, 'Calibration');
    wizardState.showNotice(`Could not embed calibration curves into the profile: ${err}`, 'warning', 7000);
    return null;
  }
}

function statusLabel() {
  if (calState.status === 'none') return 'Calibration: None';
  const name = calState.filename || 'curves.cal';
  if (calState.status === 'stale') return `Calibration: Stale (${name})`;
  if (!calState.applyEnabled) return `Calibration: Loaded, not applied (${name})`;
  return `Calibration: Active (${name})`;
}

function persistLocal() {
  try {
    localStorage.setItem('iccery.calibration', JSON.stringify({
      calPath: calState.calPath,
      applyEnabled: calState.applyEnabled,
      printerName: calState.printerName,
      colourSpace: calState.colourSpace,
      created: calState.created,
      calBasename: calState.calBasename,
    }));
  } catch (_) { /* private mode */ }
}

function restoreLocal() {
  try {
    const raw = localStorage.getItem('iccery.calibration');
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.calPath) {
      calState.calPath = parsed.calPath;
      calState.applyEnabled = parsed.applyEnabled !== false;
      calState.printerName = parsed.printerName || null;
      calState.colourSpace = parsed.colourSpace || null;
      calState.created = parsed.created || null;
      calState.calBasename = parsed.calBasename || makeCalibrationBasename(wizardState.basename);
      calState.filename = String(parsed.calPath).split(/[\\/]/).pop();
      calState.status = 'active';
    }
  } catch (_) { /* ignore */ }
}

async function persistProject() {
  if (!wizardState.cwd) return;
  try {
    await invoke('save_project_calibration', {
      cwd: wizardState.cwd,
      state: {
        cal_path: calState.calPath,
        apply_enabled: calState.applyEnabled,
        printer_name: calState.printerName,
        colour_space: calState.colourSpace,
        created: calState.created,
        cal_basename: calState.calBasename,
        ink_limit_overrides: calState.inkLimits,
        total_ink_override: calState.totalInkLimit,
      },
    });
  } catch (err) {
    logger.warn(`Could not persist project calibration: ${err}`, 'Calibration');
  }
}

function refreshStatusFromMeta(meta, currentPrinter) {
  if (!meta) {
    calState.status = calState.calPath ? 'active' : 'none';
    return;
  }
  calState.filename = meta.filename;
  calState.created = meta.created;
  calState.ageDays = meta.age_days || 0;
  calState.curves = meta.curves || [];
  if (meta.ink_limits && meta.ink_limits.length) calState.inkLimits = meta.ink_limits;
  if (meta.total_ink_limit != null) calState.totalInkLimit = meta.total_ink_limit;
  calState.status = classifyCalibrationStatus({
    calPath: calState.calPath,
    applyEnabled: calState.applyEnabled,
    ageDays: calState.ageDays,
    staleDays: calState.staleDays,
    printerName: calState.printerName,
    currentPrinter,
  });
}

function renderBanners() {
  const text = statusLabel();
  document.querySelectorAll('[data-cal-banner-text]').forEach((el) => {
    el.textContent = text;
  });
  document.querySelectorAll('[data-cal-banner]').forEach((el) => {
    el.classList.toggle('hidden', calState.status === 'none' && el.dataset.calBanner !== 'always');
    el.classList.toggle('cal-banner-stale', calState.status === 'stale');
    el.classList.toggle('cal-banner-active', calState.status === 'active');
  });
  document.querySelectorAll('[data-cal-apply]').forEach((el) => {
    el.checked = !!calState.applyEnabled && !!calState.calPath;
    el.disabled = !calState.calPath;
  });
  const chip = document.getElementById('calStatusChip');
  if (chip) {
    chip.textContent = text;
    chip.className = `cal-status-chip cal-status-${calState.status}`;
  }
  const rgbHint = document.getElementById('calRgbHint');
  if (rgbHint) {
    const cs = (document.querySelector('input[name="calColourSpace"]:checked') || {}).value
      || (document.querySelector('input[name="colourSpace"]:checked') || {}).value
      || 'rgb';
    rgbHint.classList.toggle('hidden', cs !== 'rgb');
  }
  const stage1Banner = document.getElementById('calStage1Recommend');
  if (stage1Banner) {
    const cs = (document.querySelector('input[name="colourSpace"]:checked') || {}).value || 'rgb';
    const show = calState.status === 'none' && cs === 'cmyk';
    stage1Banner.classList.toggle('hidden', !show);
  }
}

function renderPlots() {
  const svg = document.getElementById('calCurveSvg');
  const legend = document.getElementById('calCurveLegend');
  if (!svg) return;
  const width = 360;
  const height = 180;
  const padding = 22;
  const grid = [0, 0.25, 0.5, 0.75, 1].map((t) => {
    const x = padding + t * (width - padding * 2);
    const y = padding + (1 - t) * (height - padding * 2);
    return `<line x1="${padding}" y1="${y}" x2="${width - padding}" y2="${y}" class="cal-grid"/>`
      + `<line x1="${x}" y1="${padding}" x2="${x}" y2="${height - padding}" class="cal-grid"/>`;
  }).join('');
  const identity = buildCurvePolyline([[0, 0], [1, 1]], width, height, padding);
  const paths = (calState.curves || []).map((curve) => {
    const d = buildCurvePolyline(curve.points, width, height, padding);
    const color = CHANNEL_COLORS[curve.channel] || '#7aa2f7';
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2"/>`;
  }).join('');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.innerHTML = `${grid}<path d="${identity}" fill="none" stroke="#555" stroke-dasharray="4 3" stroke-width="1"/>${paths}`
    + `<text x="${padding}" y="${height - 4}" class="cal-axis-label">Input</text>`
    + `<text x="4" y="${padding}" class="cal-axis-label">Out</text>`;
  if (legend) {
    legend.innerHTML = (calState.curves || []).map((c) => {
      const color = CHANNEL_COLORS[c.channel] || '#7aa2f7';
      return `<span class="cal-legend-item"><i style="background:${color}"></i>${c.channel}</span>`;
    }).join('') || '<span class="help-hint">No curves yet — compute after measuring the calibration chart.</span>';
  }
}

function renderInkLimits() {
  const wrap = document.getElementById('calInkLimitControls');
  const tacEl = document.getElementById('calTacValue');
  if (tacEl) {
    const tac = calState.totalInkLimit != null ? calState.totalInkLimit : totalAreaCoverage(calState.inkLimits);
    tacEl.textContent = tac ? `${tac.toFixed(0)} %` : '—';
  }
  if (!wrap) return;
  if (!calState.inkLimits.length) {
    wrap.innerHTML = '<p class="help-hint">Ink-limit recommendations appear after printcal runs. Editable overrides can be re-computed.</p>';
    return;
  }
  wrap.innerHTML = calState.inkLimits.map((lim) => {
    const color = CHANNEL_COLORS[lim.channel] || '#888';
    return `<label class="cal-ink-row"><span style="color:${color}">${lim.channel}</span>`
      + `<input type="range" min="50" max="100" step="0.5" value="${lim.percent}" data-cal-ink="${lim.channel}">`
      + `<input type="number" min="50" max="100" step="0.5" value="${Number(lim.percent).toFixed(1)}" data-cal-ink-num="${lim.channel}">`
      + `<span>%</span></label>`;
  }).join('');
}

function renderDashboardMeta() {
  const fileEl = document.getElementById('calCurrentFile');
  if (fileEl) fileEl.textContent = calState.filename || 'No .cal loaded';
  const powerEl = document.getElementById('calRecommendedPower');
  if (powerEl) powerEl.textContent = calState.recommendedPower != null ? calState.recommendedPower.toFixed(2) : '—';
  renderBanners();
  renderPlots();
  renderInkLimits();
}

async function loadCalPath(path) {
  const meta = await invoke('parse_cal_file_cmd', { path });
  calState.calPath = path;
  calState.applyEnabled = true;
  refreshStatusFromMeta(meta, wizardState.printerName);
  if (!calState.calBasename) {
    calState.calBasename = makeCalibrationBasename(wizardState.basename || 'printer');
  }
  persistLocal();
  await persistProject();
  renderDashboardMeta();
  wizardState.showNotice(`Loaded calibration ${meta.filename}`, 'success', 4000);
}

async function enterCalibrationSession() {
  const calBase = calState.calBasename || makeCalibrationBasename(wizardState.basename || 'printer');
  calState.calBasename = calBase;
  if (wizardState.basename && !isCalibrationBasename(wizardState.basename)) {
    wizardState.profileBasename = wizardState.basename;
  }
  wizardState.sessionMode = 'calibration';
  wizardState.basename = calBase;
  wizardState.setTarget(calBase, wizardState.cwd);
  const { setStage1Result } = await import('./printtarg.js');
  const { setStage2Result } = await import('./chartread.js');
  setStage1Result(calBase, wizardState.cwd);
  setStage2Result(calBase, wizardState.cwd);
}

async function exitCalibrationSession() {
  wizardState.sessionMode = 'profile';
  if (wizardState.profileBasename) {
    wizardState.basename = wizardState.profileBasename;
    wizardState.setTarget(wizardState.profileBasename, wizardState.cwd);
    const { setStage1Result } = await import('./printtarg.js');
    setStage1Result(wizardState.profileBasename, wizardState.cwd);
  }
}

async function generateTarget() {
  const cwd = wizardState.cwd;
  if (!cwd) {
    wizardState.showNotice('Set a working directory in Stage 1 before generating a calibration chart.', 'warning');
    return;
  }
  const cs = (document.querySelector('input[name="calColourSpace"]:checked') || {}).value
    || (document.querySelector('input[name="colourSpace"]:checked') || {}).value
    || 'rgb';
  const steps = Math.max(11, Math.min(51, parseInt(document.getElementById('calSteps')?.value, 10) || 21));
  const ink = parseInt(document.getElementById('calInkExplore')?.value, 10);
  const basename = makeCalibrationBasename(wizardState.profileBasename || wizardState.basename || 'printer');
  calState.calBasename = basename;
  calState.colourSpace = cs;
  const btn = document.getElementById('btnCalGenerate');
  const logPre = document.getElementById('calLog');
  const logBox = document.getElementById('calLogContainer');
  if (logBox) logBox.classList.remove('hidden');
  if (btn) btn.disabled = true;
  const processId = `targen_${basename}`;
  if (logPre) logPre.textContent = 'Starting targen (calibration chart)...\n';
  try {
    const unlistenStdout = await listen('process:stdout', (event) => {
      if (event.payload.id === processId && event.payload.line && logPre) {
        logPre.textContent += `${event.payload.line}\n`;
      }
    });
    const unlistenStderr = await listen('process:stderr', (event) => {
      if (event.payload.id === processId && event.payload.line && logPre) {
        logPre.textContent += `ERR: ${event.payload.line}\n`;
      }
    });
    const unlistenExit = await listen('process:exit', (event) => {
      if (event.payload.id !== processId) return;
      unlistenStdout();
      unlistenStderr();
      unlistenExit();
      if (btn) btn.disabled = false;
      if (event.payload.code === 0) {
        if (logPre) logPre.textContent += '\n[SUCCESS] Calibration .ti1 generated.\n';
        wizardState.showNotice(`Calibration chart ${basename}.ti1 is ready. Create a layout and print it uncalibrated.`, 'success', 6000);
      } else if (logPre) {
        logPre.textContent += `\n[ERROR] targen exited with code ${event.payload.code}.\n`;
      }
    });
    await invoke('generate_calibration_target', {
      config: {
        colour_space: cs,
        steps_per_channel: steps,
        ink_limit_exploration: Number.isFinite(ink) ? ink : null,
        channels: null,
        white_patches: 4,
        neutral_emphasis: !!(document.getElementById('calNeutralEmphasis') || {}).checked,
        basename,
        cwd,
      },
    });
  } catch (err) {
    if (btn) btn.disabled = false;
    logger.error(`generate_calibration_target failed: ${err}`, 'Calibration');
    wizardState.showNotice(`Could not generate calibration chart: ${err}`, 'error');
  }
}

function collisionChoice(existingPath) {
  return new Promise((resolve) => {
    const dialog = document.getElementById('calCollisionDialog');
    const msg = document.getElementById('calCollisionMessage');
    if (msg) msg.textContent = `A calibration file already exists:\n${existingPath}`;
    if (!dialog || typeof dialog.showModal !== 'function') {
      const ok = window.confirm(`Overwrite existing calibration ${existingPath}?`);
      resolve(ok ? 'overwrite' : 'cancel');
      return;
    }
    const finish = (choice) => {
      dialog.close();
      resolve(choice);
    };
    document.getElementById('calOverwriteBtn')?.addEventListener('click', () => finish('overwrite'), { once: true });
    document.getElementById('calRenameBtn')?.addEventListener('click', () => finish('rename'), { once: true });
    document.getElementById('calCancelCollisionBtn')?.addEventListener('click', () => finish('cancel'), { once: true });
    dialog.showModal();
  });
}

async function computeCurves(forceOverwrite = false, outputName = null) {
  const cwd = wizardState.cwd;
  const basename = calState.calBasename || makeCalibrationBasename(wizardState.basename || 'printer');
  if (!cwd) {
    wizardState.showNotice('Working directory is not set.', 'warning');
    return;
  }
  const btn = document.getElementById('btnCalCompute');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Computing…';
  }
  const channelLimits = [];
  document.querySelectorAll('[data-cal-ink-num]').forEach((el) => {
    channelLimits.push({ channel: el.getAttribute('data-cal-ink-num'), percent: parseFloat(el.value) });
  });
  const tac = parseFloat(document.getElementById('calTacOverride')?.value);
  try {
    const result = await invoke('compute_calibration_curves', {
      config: {
        ti3_basename: basename,
        cwd,
        output_cal: outputName,
        previous_cal: calState.calPath,
        force_overwrite: forceOverwrite,
        no_ink_limit: false,
        verify: false,
        total_ink_limit: Number.isFinite(tac) ? tac : null,
        channel_limits: channelLimits,
      },
    });
    calState.calPath = result.cal_path;
    calState.filename = String(result.cal_path).split(/[\\/]/).pop();
    calState.inkLimits = result.ink_limits || [];
    calState.totalInkLimit = result.total_ink_limit;
    calState.recommendedPower = result.recommended_power;
    calState.applyEnabled = true;
    calState.printerName = wizardState.printerName || calState.printerName;
    calState.created = new Date().toISOString();
    refreshStatusFromMeta(result.metadata, wizardState.printerName);
    persistLocal();
    await persistProject();
    renderDashboardMeta();
    wizardState.showNotice(result.message, 'success', 6000);
  } catch (err) {
    const message = String(err);
    if (/already exists/i.test(message) && !forceOverwrite) {
      const choice = await collisionChoice(message);
      if (choice === 'overwrite') {
        await computeCurves(true, outputName);
      } else if (choice === 'rename') {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        await computeCurves(true, `${basename}_${stamp}.cal`);
      }
    } else {
      wizardState.showNotice(`printcal failed: ${err}`, 'error', 8000);
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Compute Curves';
    }
  }
}

async function refreshSavedList() {
  const select = document.getElementById('calSavedSelect');
  if (!select) return;
  try {
    const list = await invoke('list_saved_calibrations', { cwd: wizardState.cwd || null });
    const current = select.value;
    select.innerHTML = '<option value="">Recent calibrations…</option>';
    list.forEach((item) => {
      const opt = document.createElement('option');
      opt.value = item.path;
      const stale = isCalibrationStale(item.age_days, calState.staleDays) ? ' (stale)' : '';
      opt.textContent = `${item.filename}${stale}`;
      select.appendChild(opt);
    });
    if (current) select.value = current;
  } catch (err) {
    logger.warn(`list_saved_calibrations: ${err}`, 'Calibration');
  }
}

export function initCalibration() {
  restoreLocal();
  renderDashboardMeta();

  const openBtn = document.getElementById('btnCalibratePrinter');
  if (openBtn) {
    openBtn.addEventListener('click', () => {
      wizardState.navigateToStage(0);
      refreshSavedList();
    });
  }
  document.getElementById('btnCalBackToWizard')?.addEventListener('click', () => {
    exitCalibrationSession();
    wizardState.navigateToStage(1);
  });
  document.getElementById('btnCalGenerate')?.addEventListener('click', generateTarget);
  document.getElementById('btnCalLayout')?.addEventListener('click', async () => {
    await enterCalibrationSession();
    wizardState.showNotice('Printing a calibration chart: color management stays bypassed and curves are not applied to this target.', 'info', 7000);
    wizardState.navigateToStage(2);
  });
  document.getElementById('btnCalMeasure')?.addEventListener('click', async () => {
    await enterCalibrationSession();
    wizardState.showNotice('Measuring the calibration chart. After Finish, return here and compute curves.', 'info', 7000);
    wizardState.navigateToStage(3);
  });
  document.getElementById('btnCalCompute')?.addEventListener('click', () => computeCurves(false, null));
  document.getElementById('btnCalLoad')?.addEventListener('click', async () => {
    try {
      const picked = await invoke('select_cal_file', { defaultDir: wizardState.cwd || null });
      if (picked) await loadCalPath(picked);
    } catch (err) {
      wizardState.showNotice(`Could not open .cal file: ${err}`, 'error');
    }
  });
  document.getElementById('btnCalClear')?.addEventListener('click', async () => {
    calState.status = 'none';
    calState.calPath = null;
    calState.filename = null;
    calState.curves = [];
    calState.inkLimits = [];
    calState.totalInkLimit = null;
    persistLocal();
    await persistProject();
    renderDashboardMeta();
    wizardState.showNotice('Calibration cleared. Profiling will run without printcal curves.', 'info');
  });
  document.getElementById('btnCalLibrary')?.addEventListener('click', async () => {
    if (!calState.calPath) return;
    try {
      const dest = await invoke('save_calibration_to_library', { calPath: calState.calPath });
      wizardState.showNotice(`Copied to library: ${dest}`, 'success');
      refreshSavedList();
    } catch (err) {
      wizardState.showNotice(`Library save failed: ${err}`, 'error');
    }
  });
  document.getElementById('calSavedSelect')?.addEventListener('change', async (ev) => {
    if (ev.target.value) await loadCalPath(ev.target.value);
  });
  document.getElementById('calApplyToggleDash')?.addEventListener('change', async (ev) => {
    calState.applyEnabled = !!ev.target.checked;
    persistLocal();
    await persistProject();
    renderBanners();
  });
  document.querySelectorAll('[data-cal-apply]').forEach((el) => {
    el.addEventListener('change', async (ev) => {
      calState.applyEnabled = !!ev.target.checked;
      persistLocal();
      await persistProject();
      renderBanners();
    });
  });
  document.getElementById('btnCalRecalibrate')?.addEventListener('click', () => {
    wizardState.navigateToStage(0);
  });
  document.getElementById('btnDriftRecalibrate')?.addEventListener('click', () => {
    wizardState.navigateToStage(0);
  });

  document.querySelectorAll('input[name="calColourSpace"]').forEach((el) => {
    el.addEventListener('change', renderBanners);
  });
  document.querySelectorAll('input[name="colourSpace"]').forEach((el) => {
    el.addEventListener('change', renderBanners);
  });

  document.getElementById('calInkLimitControls')?.addEventListener('input', (ev) => {
    const ch = ev.target.getAttribute('data-cal-ink') || ev.target.getAttribute('data-cal-ink-num');
    if (!ch) return;
    const val = parseFloat(ev.target.value);
    const range = document.querySelector(`[data-cal-ink="${ch}"]`);
    const num = document.querySelector(`[data-cal-ink-num="${ch}"]`);
    if (range && ev.target !== range) range.value = val;
    if (num && ev.target !== num) num.value = val;
    const item = calState.inkLimits.find((l) => l.channel === ch);
    if (item) item.percent = val;
    const tacEl = document.getElementById('calTacValue');
    if (tacEl) tacEl.textContent = `${totalAreaCoverage(calState.inkLimits).toFixed(0)} %`;
  });

  window.addEventListener('stage-changed', (event) => {
    if (event.detail && event.detail.stage !== 0 && event.detail.stage !== 2 && event.detail.stage !== 3) {
      if (wizardState.sessionMode === 'calibration') {
        exitCalibrationSession();
      }
    }
    renderBanners();
  });

  window.addEventListener('settings-saved', (event) => {
    const days = event.detail && event.detail.calibration_stale_days;
    if (days) calState.staleDays = days;
    refreshStatusFromMeta({
      filename: calState.filename,
      created: calState.created,
      age_days: calState.ageDays,
      curves: calState.curves,
      ink_limits: calState.inkLimits,
      total_ink_limit: calState.totalInkLimit,
    }, wizardState.printerName);
    renderBanners();
  });

  if (wizardState.cwd) {
    invoke('load_project_calibration', { cwd: wizardState.cwd }).then(async (state) => {
      if (state && state.cal_path) {
        try { await loadCalPath(state.cal_path); } catch (_) { /* missing file */ }
        calState.applyEnabled = state.apply_enabled !== false;
        renderBanners();
      }
    }).catch(() => {});
  }
}
