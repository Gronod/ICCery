import { initTargen } from './targen.js';
import { initPrinttarg } from './printtarg.js';
import { initChartread } from './chartread.js';
import { initColprof } from './colprof.js';
import { initProfcheck } from './profcheck.js';
import { initSettings } from './settings.js';
import { initGamutViewer } from './gamut_viewer.js';
import { initPresets } from './presets.js';
import { wizardState } from './state.js';
import { logger } from './logger.js';

const { invoke } = window.__TAURI__.core;

document.addEventListener('DOMContentLoaded', () => {
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

  // Initialize all stages & features safely
  safeInit('Stage 1 (Targen)', initTargen);
  safeInit('Stage 2 (Printtarg)', initPrinttarg);
  safeInit('Stage 3 (Chartread)', initChartread);
  safeInit('Stage 4 (Colprof)', initColprof);
  safeInit('Stage 5 (Profcheck)', initProfcheck);
  safeInit('Settings', initSettings);
  safeInit('Gamut Viewer', initGamutViewer);
  safeInit('Presets', initPresets);
});
