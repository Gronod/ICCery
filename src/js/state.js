const { invoke } = window.__TAURI__.core;

export const wizardState = {
  currentStage: 1,
  basename: "",
  cwd: "",
  
  setTarget(basename, cwd) {
    if (basename) this.basename = basename;
    if (cwd) this.cwd = cwd;
    this.updateGating();
  },

  async updateGating() {
    const steps = document.querySelectorAll('.step');
    if (!steps || steps.length === 0) return;

    if (!this.basename || !this.cwd) {
      steps.forEach((step, idx) => {
        if (idx === 0) {
          step.classList.remove('disabled');
        } else {
          step.classList.add('disabled');
        }
      });
      return;
    }

    try {
      const status = await invoke('verify_stage_artefacts', {
        cwd: this.cwd,
        basename: this.basename,
      });

      // Step 1: always accessible
      // Step 2: unlocked if .ti1 exists
      // Step 3: unlocked if .ti2 exists
      // Step 4: unlocked if .ti3 exists
      // Step 5: unlocked if profile exists
      const unlocked = [
        true,
        status.stage1_complete,
        status.stage2_complete,
        status.stage3_complete,
        status.stage4_complete,
      ];

      steps.forEach((step, idx) => {
        if (unlocked[idx]) {
          step.classList.remove('disabled');
        } else {
          step.classList.add('disabled');
        }
      });
    } catch (e) {
      console.warn("Could not verify stage artefacts:", e);
    }
  }
};
