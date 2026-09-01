const { invoke } = window.__TAURI__.core;

export class CgatsInterop {
  constructor(appState) {
    this.appState = appState;
    this.bindEvents();
  }

  bindEvents() {
    // Stage 1: Import
    const importBtn = document.getElementById('btn-import-dataset');
    if (importBtn) {
      importBtn.addEventListener('click', () => this.handleImport());
    }

    // Stage 3/4: Export
    const exportBtn = document.getElementById('btn-export-dataset');
    if (exportBtn) {
      exportBtn.addEventListener('click', () => this.handleExport());
    }
  }

  async handleImport() {
    try {
      const filePath = await invoke('select_target_file');
      if (!filePath) return; // User cancelled

      // Inspect first to show modal (optional, skipping for now, directly import)
      // Since we are mocking the UI a bit for this branch, we will just import directly
      const summary = await invoke('import_measurement_dataset', {
        filePath,
        targetCwd: this.appState.cwd,
        targetBasename: this.appState.basename,
      });

      this.appState.showNotice(`Successfully imported dataset (${summary.patch_count} patches)`, 'success');
      
      // Update state to jump to stage 4
      await this.appState.updateGating();
      this.appState.currentStage = 4;
      this.appState.applyStageDOM(4);
      
    } catch (e) {
      this.appState.showNotice(`Failed to import dataset: ${e}`, 'error');
    }
  }

  async handleExport() {
    try {
      // Mocking export for now since UI modal is complex
      this.appState.showNotice('Export functionality will be available in the next release.', 'info');
    } catch (e) {
      this.appState.showNotice(`Failed to export dataset: ${e}`, 'error');
    }
  }
}
