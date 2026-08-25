import { initTargen } from './targen.js';
import { initPrinttarg } from './printtarg.js';
import { initChartread } from './chartread.js';
import { initColprof } from './colprof.js';
import { initProfcheck } from './profcheck.js';
import { initSettings } from './settings.js';
import { initGamutViewer } from './gamut_viewer.js';
import { initPresets } from './presets.js';
import { wizardState } from './state.js';

const { invoke } = window.__TAURI__.core;

document.addEventListener('DOMContentLoaded', () => {
  // Wizard navigation
  const steps = document.querySelectorAll('.step');
  const stages = document.querySelectorAll('.stage');

  // Initialize gating on load
  wizardState.updateGating();

  steps.forEach(step => {
    step.addEventListener('click', () => {
      if (step.classList.contains('disabled')) {
        return;
      }

      const targetStep = step.getAttribute('data-step');
      
      // Update UI
      steps.forEach(s => s.classList.remove('active'));
      stages.forEach(s => {
        s.classList.remove('active');
        s.classList.add('hidden');
      });
      
      step.classList.add('active');
      const targetStage = document.getElementById(`stage-${targetStep}`);
      if (targetStage) {
        targetStage.classList.remove('hidden');
        targetStage.classList.add('active');
      }
    });
  });

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
      console.error(`[ICCery Init Error] Failed to initialize ${name}:`, e);
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
