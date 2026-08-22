import { initTargen } from './targen.js';
import { initPrinttarg } from './printtarg.js';
import { initChartread } from './chartread.js';
import { initColprof } from './colprof.js';
import { initProfcheck } from './profcheck.js';
import { initSettings } from './settings.js';
import { initGamutViewer } from './gamut_viewer.js';

const { invoke } = window.__TAURI__.core;

document.addEventListener('DOMContentLoaded', () => {
  // Wizard navigation
  const steps = document.querySelectorAll('.step');
  const stages = document.querySelectorAll('.stage');

  steps.forEach(step => {
    step.addEventListener('click', () => {
      const targetStep = step.getAttribute('data-step');
      
      // Update UI
      steps.forEach(s => s.classList.remove('active'));
      stages.forEach(s => {
        s.classList.remove('active');
        s.classList.add('hidden');
      });
      
      step.classList.add('active');
      const targetStage = document.getElementById(`stage-${targetStep}`);
      targetStage.classList.remove('hidden');
      targetStage.classList.add('active');
    });
  });

  // Initialize Stage 1
  initTargen();

  // Initialize Stage 2
  initPrinttarg();

  // Initialize Stage 3
  initChartread();

  // Initialize Stage 4
  initColprof();

  // Initialize Stage 5
  initProfcheck();

  // Initialize Settings
  initSettings();

  // Initialize 3D Gamut Viewer
  initGamutViewer();
});
