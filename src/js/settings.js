const { invoke } = window.__TAURI__.core;
import { logger } from './logger.js';

function getInputValueAsFloat(id, fallback) {
  const el = document.getElementById(id);
  if (!el) return fallback;
  const v = parseFloat(el.value);
  return Number.isNaN(v) ? fallback : v;
}

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
    const deltaEGoodMax = document.getElementById('deltaEGoodMax');
    const deltaEWarningMax = document.getElementById('deltaEWarningMax');
    const deltaEThresholdError = document.getElementById('deltaEThresholdError');

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

    function validateDeltaEThresholds() {
        if (!deltaEGoodMax || !deltaEWarningMax) return true;
        const good = parseFloat(deltaEGoodMax.value);
        const warn = parseFloat(deltaEWarningMax.value);
        const valid = !Number.isNaN(good) && !Number.isNaN(warn) && good < warn && good >= 0 && warn >= 0;
        if (deltaEThresholdError) {
            deltaEThresholdError.style.display = valid ? 'none' : 'block';
        }
        return valid;
    }

    if (deltaEGoodMax) {
        deltaEGoodMax.addEventListener('input', validateDeltaEThresholds);
    }
    if (deltaEWarningMax) {
        deltaEWarningMax.addEventListener('input', validateDeltaEThresholds);
    }

    openBtn.addEventListener('click', async () => {
        try {
            const settings = await invoke('load_settings');
            document.getElementById('argyll_binary_dir').value = settings.argyll_binary_dir || '';
            document.getElementById('default_instrument').value = settings.default_instrument || '';
            if (logLevelSelect && settings.log_level) {
                logLevelSelect.value = settings.log_level;
            }
            if (deltaEGoodMax) {
                deltaEGoodMax.value = Number(settings.delta_e_good_max ?? 2.0).toFixed(1);
            }
            if (deltaEWarningMax) {
                deltaEWarningMax.value = Number(settings.delta_e_warning_max ?? 5.0).toFixed(1);
            }
            validateDeltaEThresholds();
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
                if (!validateDeltaEThresholds()) {
                    throw new Error('Invalid ΔE thresholds');
                }
                const currentSettings = await invoke('load_settings').catch(() => ({}));
                const settings = {
                    ...currentSettings,
                    argyll_binary_dir: document.getElementById('argyll_binary_dir').value.trim() || null,
                    default_instrument: document.getElementById('default_instrument').value.trim() || null,
                    log_level: logLevelSelect ? logLevelSelect.value : (currentSettings.log_level || 'info'),
                    delta_e_good_max: getInputValueAsFloat('deltaEGoodMax', 2.0),
                    delta_e_warning_max: getInputValueAsFloat('deltaEWarningMax', 5.0),
                };
                await invoke('save_settings', { settings });
                logger.info(`Settings saved. Log level set to: ${settings.log_level}`, 'Settings');
                // Notify other UI modules (e.g. swatch grid) that settings changed.
                window.dispatchEvent(new CustomEvent('settings-saved', { detail: settings }));
                dialog.close();
            } catch (e) {
                logger.error(`Failed to save settings: ${e}`, 'Settings');
                alert(`Failed to save settings: ${e}`);
            }
        });
    }
}
