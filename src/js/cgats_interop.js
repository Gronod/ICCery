const invoke = typeof window !== 'undefined' && window.__TAURI__?.core?.invoke
  ? window.__TAURI__.core.invoke
  : async () => {};

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
      const filePath = await invoke('select_dataset_file', {
        defaultDir: this.appState?.cwd || null,
      });
      if (!filePath) return; // User cancelled

      const isWindows = filePath.includes('\\');
      const sep = isWindows ? '\\' : '/';
      const parts = filePath.split(sep);
      const fileName = parts.pop();
      const fileDir = parts.join(sep);
      const fileStem = fileName.replace(/\.[^/.]+$/, '');

      const targetCwd = this.appState?.cwd || fileDir;
      const targetBasename = this.appState?.basename || fileStem;

      const targetBasenameInput = document.getElementById('targetBasename');
      if (targetBasenameInput && !targetBasenameInput.value.trim()) {
        targetBasenameInput.value = targetBasename;
      }
      const selectedPathDisplay = document.getElementById('selectedPathDisplay');
      if (selectedPathDisplay && (!selectedPathDisplay.textContent || selectedPathDisplay.textContent.includes('No directory') || !this.appState?.cwd)) {
        selectedPathDisplay.textContent = `Directory: ${targetCwd}`;
      }

      if (this.appState?.setTarget) {
        await this.appState.setTarget(targetBasename, targetCwd);
      }

      const summary = await invoke('import_measurement_dataset', {
        filePath,
        targetCwd,
        targetBasename,
      });

      this.appState?.showNotice?.(`Successfully imported dataset (${summary.patch_count} patches)`, 'success');
      
      // Update state to jump to stage 4
      if (this.appState?.updateGating) {
        await this.appState.updateGating();
      }
      if (this.appState) {
        this.appState.currentStage = 4;
        this.appState.applyStageDOM?.(4);
      }
      
    } catch (e) {
      this.appState?.showNotice?.(`Failed to import dataset: ${e}`, 'error');
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
