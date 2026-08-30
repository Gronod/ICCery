const { invoke } = window.__TAURI__.core;
import { logger } from './logger.js';

export async function initSettings() {
    const dialog = document.getElementById('settingsDialog');
    const openBtn = document.getElementById('openSettingsBtn');
    const saveBtn = document.getElementById('saveSettingsBtn');
    const closeBtn = document.getElementById('closeSettingsBtn');
    const logLevelSelect = document.getElementById('logLevelSelect');
    const btnOpenLogFolder = document.getElementById('btnOpenLogFolder');
    const btnCopyLogPath = document.getElementById('btnCopyLogPath');
    const btnCopyLogExcerpt = document.getElementById('btnCopyLogExcerpt');
    const logPathDisplay = document.getElementById('logPathDisplay');

    if (!dialog || !openBtn) return;

    async function refreshLogPath() {
        if (!logPathDisplay) return;
        try {
            const path = await invoke('get_log_path');
            logPathDisplay.textContent = path ? `Log file: ${path}` : '';
        } catch (err) {
            logger.warn(`Could not retrieve log path: ${err}`, 'Settings');
        }
    }

    openBtn.addEventListener('click', async () => {
        try {
            const settings = await invoke('load_settings');
            document.getElementById('argyll_binary_dir').value = settings.argyll_binary_dir || '';
            document.getElementById('default_instrument').value = settings.default_instrument || '';
            if (logLevelSelect && settings.log_level) {
                logLevelSelect.value = settings.log_level;
            }
            await refreshLogPath();
            dialog.showModal();
        } catch (e) {
            logger.error(`Failed to load settings: ${e}`, 'Settings');
        }
    });

    if (btnOpenLogFolder) {
        btnOpenLogFolder.addEventListener('click', async () => {
            try {
                await invoke('open_log_dir');
            } catch (err) {
                logger.error(`Failed to open log folder: ${err}`, 'Settings');
                alert(`Failed to open log folder: ${err}`);
            }
        });
    }

    if (btnCopyLogPath) {
        btnCopyLogPath.addEventListener('click', async () => {
            try {
                const path = await invoke('get_log_path');
                if (path) {
                    await navigator.clipboard.writeText(path);
                    const originalText = btnCopyLogPath.textContent;
                    btnCopyLogPath.textContent = '✓ Copied!';
                    setTimeout(() => {
                        btnCopyLogPath.textContent = originalText;
                    }, 2000);
                }
            } catch (err) {
                logger.error(`Failed to copy log path: ${err}`, 'Settings');
                alert(`Failed to copy log path: ${err}`);
            }
        });
    }

    if (btnCopyLogExcerpt) {
        btnCopyLogExcerpt.addEventListener('click', async () => {
            try {
                const excerpt = await invoke('get_recent_log_excerpt', {
                    maxLines: 200,
                    maxBytes: 65536,
                });
                if (excerpt) {
                    await navigator.clipboard.writeText(excerpt);
                    const lineCount = excerpt.split('\n').length;
                    const originalText = btnCopyLogExcerpt.textContent;
                    btnCopyLogExcerpt.textContent = `✓ Copied (${lineCount} lines)!`;
                    setTimeout(() => {
                        btnCopyLogExcerpt.textContent = originalText;
                    }, 2500);
                }
            } catch (err) {
                logger.error(`Failed to copy log excerpt: ${err}`, 'Settings');
                alert(`Failed to copy log excerpt: ${err}`);
            }
        });
    }

    if (closeBtn) {
        closeBtn.addEventListener('click', () => dialog.close());
    }

    if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
            try {
                const currentSettings = await invoke('load_settings').catch(() => ({}));
                const settings = {
                    ...currentSettings,
                    argyll_binary_dir: document.getElementById('argyll_binary_dir').value.trim() || null,
                    default_instrument: document.getElementById('default_instrument').value.trim() || null,
                    log_level: logLevelSelect ? logLevelSelect.value : (currentSettings.log_level || 'info'),
                };
                await invoke('save_settings', { settings });
                logger.info(`Settings saved. Log level set to: ${settings.log_level}`, 'Settings');
                dialog.close();
            } catch (e) {
                logger.error(`Failed to save settings: ${e}`, 'Settings');
            }
        });
    }
}
