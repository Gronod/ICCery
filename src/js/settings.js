const { invoke } = window.__TAURI__.core;

export async function initSettings() {
    const dialog = document.getElementById('settingsDialog');
    const openBtn = document.getElementById('openSettingsBtn');
    const saveBtn = document.getElementById('saveSettingsBtn');
    const closeBtn = document.getElementById('closeSettingsBtn');

    if (!dialog || !openBtn) return;

    openBtn.addEventListener('click', async () => {
        try {
            const settings = await invoke('load_settings');
            document.getElementById('argyll_binary_dir').value = settings.argyll_binary_dir || '';
            document.getElementById('default_instrument').value = settings.default_instrument || '';
            dialog.showModal();
        } catch (e) {
            console.error("Failed to load settings:", e);
        }
    });

    if (closeBtn) {
        closeBtn.addEventListener('click', () => dialog.close());
    }

    if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
            const settings = {
                argyll_binary_dir: document.getElementById('argyll_binary_dir').value.trim() || null,
                default_instrument: document.getElementById('default_instrument').value.trim() || null
            };
            try {
                await invoke('save_settings', { settings });
                dialog.close();
            } catch (e) {
                console.error("Failed to save settings:", e);
            }
        });
    }
}
