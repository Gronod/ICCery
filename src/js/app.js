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
      stages.forEach(s => s.classList.remove('active'));
      
      step.classList.add('active');
      document.getElementById(`stage-${targetStep}`).classList.add('active');
    });
  });

  // Example Tauri invoke calls for later
  document.getElementById('btnGenerate').addEventListener('click', async () => {
    console.log("Stage 1 triggered");
    // await invoke('spawn_process', { binary: 'targen', args: [...] });
  });
});
