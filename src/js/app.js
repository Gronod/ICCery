import { initTargen } from './targen.js';
import { initPrinttarg } from './printtarg.js';

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
});
