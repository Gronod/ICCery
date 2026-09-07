import { initTargen } from './targen.js';
import { initPrinttarg } from './printtarg.js';
import { initChartread } from './chartread.js';
import { initColprof } from './colprof.js';
import { initProfcheck } from './profcheck.js';
import { initSettings } from './settings.js';
import { setGpuHints } from './gamut_viewer.js';
import { initPresets } from './presets.js';
import { wizardState } from './state.js';
import { logger } from './logger.js';
import { CgatsInterop } from './cgats_interop.js';

const { invoke } = window.__TAURI__.core;

let mainWindowShown = false;

async function revealMainWindow() {
  if (mainWindowShown) return;
  mainWindowShown = true;
  try {
    await invoke('show_main_window');
  } catch (e) {
    mainWindowShown = false;
    console.warn('[ICCery] show_main_window failed:', e);
  }
}

function maybeShowConstrainedGpuNotice(info) {
  if (!info || info.os !== 'macos') return;
  const intel = info.arch === 'x86_64' || info.arch === 'x86';
  const major = typeof info.macos_major === 'number' ? info.macos_major : null;
  if (!intel || (major !== null && major >= 13)) return;
  const key = 'iccery.macos-intel-webgl-notice';
  try {
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, '1');
  } catch (_) { /* private mode */ }
  wizardState.showNotice(
    'On this Mac the 3D gamut view may be unavailable. Profiling stages still work.',
    'info',
    8000
  );
}

document.addEventListener('DOMContentLoaded', () => {
  // Initialize interoperability handlers
  new CgatsInterop(wizardState);

  // Wizard stepper navigation with re-validation
  const steps = document.querySelectorAll('.step');
  steps.forEach(step => {
    step.addEventListener('click', async () => {
      const targetStep = parseInt(step.getAttribute('data-step'), 10);
      if (isNaN(targetStep)) return;
      await wizardState.navigateToStage(targetStep);
    });
  });

  // Global wizard notification close button
  const wizardNotificationClose = document.getElementById('wizardNotificationClose');
  if (wizardNotificationClose) {
    wizardNotificationClose.addEventListener('click', () => {
      wizardState.hideNotice();
    });
  }

  // Re-validate gating on window focus (e.g. when returning after modifying files in Explorer/Finder)
  window.addEventListener('focus', () => {
    wizardState.updateGating();
  });

  document.addEventListener('visibilitychange', () => {
    logger.warn(`Frontend visibilitychange hidden=${document.hidden}`, 'WebView');
  });
  window.addEventListener('pagehide', () => {
    logger.warn('Frontend pagehide', 'WebView');
  });

  // Initialize gating on load
  wizardState.updateGating();

  // About modal
  const aboutDialog = document.getElementById('aboutDialog');
  const openAboutBtn = document.getElementById('openAboutBtn');
  const closeAboutBtn = document.getElementById('closeAboutBtn');

  const updateAppInfo = async () => {
    try {
      const info = await invoke('get_app_info');
      const versionEl = document.getElementById('aboutVersion');
      const buildDateEl = document.getElementById('aboutBuildDate');
      if (versionEl && info.version) versionEl.textContent = `v${info.version}`;
      if (buildDateEl && info.build_date) buildDateEl.textContent = info.build_date;
      setGpuHints({
        arch: info.arch,
        os: info.os,
        macosMajor: info.macos_major,
      });
      maybeShowConstrainedGpuNotice(info);
    } catch (e) {
      console.warn('[ICCery] Could not load dynamic app info:', e);
    }
  };

  updateAppInfo();

  if (openAboutBtn && aboutDialog) {
    openAboutBtn.addEventListener('click', () => {
      updateAppInfo();
      aboutDialog.showModal();
    });
  }

  if (closeAboutBtn && aboutDialog) {
    closeAboutBtn.addEventListener('click', () => {
      aboutDialog.close();
    });
  }

  const safeInit = (name, initFn) => {
    try {
      initFn();
    } catch (e) {
      logger.error(`Failed to initialize ${name}: ${e}`, 'AppInit');
    }
  };

  // Initialize all stages & features safely.
  // Gamut Viewer is deferred until Stage 5 is shown (eager WebGL on launch
  // respawns WKWebView on Monterey Intel).
  safeInit('Stage 1 (Targen)', initTargen);
  safeInit('Stage 2 (Printtarg)', initPrinttarg);
  safeInit('Stage 3 (Chartread)', initChartread);
  safeInit('Stage 4 (Colprof)', initColprof);
  safeInit('Stage 5 (Profcheck)', initProfcheck);
  safeInit('Settings', initSettings);
  safeInit('Presets', initPresets);

  // Double-rAF waits for layout + first paint of the dark CSS.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      revealMainWindow();
    });
  });
  // Fallback so a JS exception cannot leave a permanently hidden window.
  setTimeout(revealMainWindow, 1500);
});