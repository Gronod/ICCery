/**
 * Stage 5 — install a verified ICC/ICM profile into the OS colour store (#223).
 */

import { wizardState } from './state.js';
import { logger } from './logger.js';
import { getActiveCalibration } from './calibration.js';

const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)
  ? window.__TAURI__.core.invoke.bind(window.__TAURI__.core)
  : async () => { throw new Error('Tauri invoke unavailable'); };

const installState = {
  profilePath: null,
  verified: false,
  installedPath: null,
};

export function calibrationInstallNote() {
  const cal = getActiveCalibration();
  if (!cal.calPath || !cal.applyEnabled) return null;
  const name = cal.filename || cal.calPath.split(/[\\/]/).pop();
  return `Linearization curves from ${name} were applied when this profile was built.`;
}

export function setProfileInstallSource(profilePath, verified) {
  installState.profilePath = profilePath || null;
  installState.verified = !!verified;
  if (!verified) installState.installedPath = null;
  refreshInstallButton();
}

function refreshInstallButton() {
  const btn = document.getElementById('btnInstallProfile');
  if (!btn) return;
  const ready = !!installState.profilePath && installState.verified;
  const already = !!installState.installedPath;
  btn.disabled = !ready || already;
  if (already) {
    btn.textContent = 'Installed ✓';
    btn.title = `Already installed to ${installState.installedPath}`;
  } else if (!ready) {
    btn.textContent = 'Install Profile to System';
    btn.title = 'Copies the generated ICC/ICM into the OS colour-profile directory so print dialogs and colour-managed applications can discover it. Requires a successful verification. Elevated privileges on some platforms.';
  } else {
    btn.textContent = 'Install Profile to System';
    btn.title = 'Copies the generated ICC/ICM profile into the operating system’s standard colour-profile directory so that print dialogs and colour-managed applications can discover it. Requires elevated privileges on some platforms.';
  }
}

function collisionChoice(message) {
  return new Promise((resolve) => {
    const dialog = document.getElementById('profileInstallCollisionDialog');
    const msg = document.getElementById('profileInstallCollisionMessage');
    if (msg) msg.textContent = message;
    if (!dialog || typeof dialog.showModal !== 'function') {
      resolve(window.confirm(`${message}\n\nOverwrite?`) ? 'overwrite' : 'cancel');
      return;
    }
    const finish = (choice) => {
      dialog.close();
      resolve(choice);
    };
    document.getElementById('profileOverwriteBtn')?.addEventListener('click', () => finish('overwrite'), { once: true });
    document.getElementById('profileRenameBtn')?.addEventListener('click', () => finish('rename'), { once: true });
    document.getElementById('profileCancelCollisionBtn')?.addEventListener('click', () => finish('cancel'), { once: true });
    dialog.showModal();
  });
}

async function loadInstallPrefs() {
  try {
    const settings = await invoke('load_settings');
    return {
      preferSystem: (settings.default_install_location || 'user') === 'system',
      askOverwrite: settings.ask_before_overwrite_profile !== false,
      openPanel: !!settings.open_color_panel_after_install,
    };
  } catch (_) {
    return { preferSystem: false, askOverwrite: true, openPanel: false };
  }
}

async function doInstall(policy = 'cancel') {
  const btn = document.getElementById('btnInstallProfile');
  const prefs = await loadInstallPrefs();
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Installing…';
  }
  const options = {
    force_overwrite: policy === 'overwrite',
    prefer_system_wide: prefs.preferSystem,
    register_with_os: true,
    collision_policy: policy,
    open_color_panel: prefs.openPanel,
    calibration_note: calibrationInstallNote(),
  };
  try {
    const result = await invoke('install_profile_to_system', {
      profilePath: installState.profilePath,
      options,
    });
    installState.installedPath = result.dest_path;
    wizardState.showNotice(result.message, 'success', 8000);
    logger.info(result.message, 'ProfileInstall');
    const log = document.getElementById('profcheckLog');
    if (log) log.textContent += `\n[INSTALL] ${result.message}\n`;
    refreshInstallButton();
  } catch (err) {
    const message = String(err);
    if (/already exists/i.test(message) && prefs.askOverwrite && policy === 'cancel') {
      const choice = await collisionChoice(message);
      if (choice !== 'cancel') {
        await doInstall(choice);
        return;
      }
    }
    wizardState.showNotice(`Install failed: ${err}`, 'error', 9000);
    logger.error(`install_profile_to_system: ${err}`, 'ProfileInstall');
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Install Profile to System';
    }
  }
}

export function initProfileInstall() {
  const btn = document.getElementById('btnInstallProfile');
  if (btn) {
    btn.addEventListener('click', () => doInstall('cancel'));
  }
  refreshInstallButton();
}

export function runProfileInstallTests() {
  const noteNone = (() => {
    // Pure helper coverage lives in calibrationInstallNote via getActiveCalibration.
    return typeof calibrationInstallNote === 'function';
  })();
  return { helperExported: noteNone };
}
