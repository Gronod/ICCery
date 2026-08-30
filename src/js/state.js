const { invoke } = window.__TAURI__.core;

export const wizardState = {
  currentStage: 1,
  basename: "",
  cwd: "",
  noticeTimer: null,
  
  setTarget(basename, cwd) {
    if (basename) this.basename = basename;
    if (cwd) this.cwd = cwd;
    return this.updateGating();
  },

  showNotice(message, type = "warning", durationMs = 5000) {
    const banner = document.getElementById("wizardNotification");
    const textEl = document.getElementById("wizardNotificationText");
    const iconEl = document.getElementById("wizardNotificationIcon");

    if (!banner || !textEl) return;

    if (this.noticeTimer) {
      clearTimeout(this.noticeTimer);
      this.noticeTimer = null;
    }

    banner.className = `notification-banner ${type}`;
    banner.classList.remove("hidden");
    textEl.textContent = message;

    if (iconEl) {
      if (type === "success") iconEl.textContent = "✓";
      else if (type === "error") iconEl.textContent = "✕";
      else if (type === "info") iconEl.textContent = "ℹ️";
      else iconEl.textContent = "⚠️";
    }

    if (durationMs > 0) {
      this.noticeTimer = setTimeout(() => {
        this.hideNotice();
      }, durationMs);
    }
  },

  hideNotice() {
    const banner = document.getElementById("wizardNotification");
    if (banner) {
      banner.classList.add("hidden");
    }
    if (this.noticeTimer) {
      clearTimeout(this.noticeTimer);
      this.noticeTimer = null;
    }
  },

  applyStageDOM(stageNumber) {
    const steps = document.querySelectorAll('.step');
    const stages = document.querySelectorAll('.stage');

    steps.forEach(s => {
      if (s.getAttribute('data-step') === String(stageNumber)) {
        s.classList.remove('disabled');
        s.classList.add('active');
      } else {
        s.classList.remove('active');
      }
    });

    stages.forEach(s => {
      if (s.id === `stage-${stageNumber}`) {
        s.classList.remove('hidden');
        s.classList.add('active');
      } else {
        s.classList.remove('active');
        s.classList.add('hidden');
      }
    });
  },

  async navigateToStage(stageNumber) {
    const targetNum = parseInt(stageNumber, 10);
    if (isNaN(targetNum) || targetNum < 1 || targetNum > 5) return false;

    if (targetNum === 1) {
      this.currentStage = 1;
      this.applyStageDOM(1);
      return true;
    }

    const gating = await this.updateGating();
    if (gating && targetNum <= gating.maxValidStage) {
      this.currentStage = targetNum;
      this.applyStageDOM(targetNum);
      return true;
    } else {
      this.showNotice(`Stage ${targetNum} is locked because required prerequisite files are missing on disk.`, "warning");
      return false;
    }
  },

  async updateGating() {
    const steps = document.querySelectorAll('.step');
    if (!steps || steps.length === 0) return null;

    if (!this.basename || !this.cwd) {
      steps.forEach((step, idx) => {
        if (idx === 0) {
          step.classList.remove('disabled');
        } else {
          step.classList.add('disabled');
        }
      });

      if (this.currentStage > 1) {
        this.currentStage = 1;
        this.applyStageDOM(1);
      }

      return {
        stage1_complete: false,
        stage2_complete: false,
        stage3_complete: false,
        stage4_complete: false,
        maxValidStage: 1,
        unlocked: [true, false, false, false, false],
      };
    }

    try {
      const status = await invoke('verify_stage_artefacts', {
        cwd: this.cwd,
        basename: this.basename,
      });

      // Strict sequential gating:
      // Stage 1: always accessible
      // Stage 2: unlocked if .ti1 exists (stage1_complete)
      // Stage 3: unlocked if .ti1 + .ti2 exist
      // Stage 4: unlocked if .ti1 + .ti2 + .ti3 exist
      // Stage 5: unlocked if .ti1 + .ti2 + .ti3 + profile exist
      const stage1Valid = true;
      const stage2Valid = !!status.stage1_complete;
      const stage3Valid = stage2Valid && !!status.stage2_complete;
      const stage4Valid = stage3Valid && !!status.stage3_complete;
      const stage5Valid = stage4Valid && !!status.stage4_complete;

      const unlocked = [
        stage1Valid,
        stage2Valid,
        stage3Valid,
        stage4Valid,
        stage5Valid,
      ];

      let maxValidStage = 1;
      if (stage2Valid) maxValidStage = 2;
      if (stage3Valid) maxValidStage = 3;
      if (stage4Valid) maxValidStage = 4;
      if (stage5Valid) maxValidStage = 5;

      steps.forEach((step, idx) => {
        if (unlocked[idx]) {
          step.classList.remove('disabled');
        } else {
          step.classList.add('disabled');
        }
      });

      // If current stage is no longer valid, automatically navigate back to maxValidStage
      if (this.currentStage > maxValidStage) {
        this.currentStage = maxValidStage;
        this.applyStageDOM(maxValidStage);
        this.showNotice(`Target files changed on disk — returned to Stage ${maxValidStage}.`, "warning");
      }

      return {
        ...status,
        maxValidStage,
        unlocked,
      };
    } catch (e) {
      console.warn("Could not verify stage artefacts:", e);
      return null;
    }
  }
};
