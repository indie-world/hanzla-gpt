'use strict';

/*
 * Auto-update from GitHub Releases.
 *
 * Flow: check on launch (and every few hours) -> if a newer release exists,
 * prompt -> on accept, put a frameless progress window on screen and keep it
 * there until the installer takes over, so the app is visibly "updating"
 * rather than silently doing nothing.
 *
 * Downloads are NOT automatic: electron-updater would otherwise fetch in the
 * background and only surface at quit time, which is the opposite of the
 * "prompt me when I open it" behaviour wanted here.
 *
 * The progress window is driven with executeJavaScript rather than IPC so it
 * needs no preload and no relaxed CSP — it is a static page this file pokes.
 */

const { app, BrowserWindow, dialog } = require('electron');
const path = require('node:path');

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;   // re-check every 6 hours

let autoUpdater = null;
let updateWin = null;
let busy = false;          // a download/install is already in flight
let hooks = { beforeInstall: async () => {}, getParent: () => null };

function log(...args) {
  console.log('[updater]', ...args);
}

function createProgressWindow() {
  if (updateWin && !updateWin.isDestroyed()) return updateWin;
  updateWin = new BrowserWindow({
    width: 460,
    height: 240,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    show: false,
    backgroundColor: '#1b1b1f',
    title: 'Updating Hanzla-GPT',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  updateWin.removeMenu();
  updateWin.loadFile(path.join(__dirname, 'update.html'));
  updateWin.once('ready-to-show', () => updateWin.show());
  updateWin.on('closed', () => { updateWin = null; });
  return updateWin;
}

/* Pushes state into the progress page. percent === null keeps the bar in its
   sweeping/indeterminate state (download hasn't reported bytes yet). */
function paint(status, percent) {
  if (!updateWin || updateWin.isDestroyed()) return;
  const payload = JSON.stringify({ status, percent });
  updateWin.webContents.executeJavaScript(`(() => {
    const d = ${payload};
    const s = document.getElementById('status');
    const bar = document.getElementById('bar');
    const track = document.getElementById('track');
    if (s) s.textContent = d.status;
    if (bar && track) {
      if (d.percent === null || d.percent === undefined) {
        track.classList.add('indeterminate');
      } else {
        track.classList.remove('indeterminate');
        bar.style.width = Math.max(0, Math.min(100, d.percent)) + '%';
      }
    }
  })();`).catch(() => { /* window closed mid-update; nothing to paint */ });
}

function closeProgressWindow() {
  if (updateWin && !updateWin.isDestroyed()) updateWin.destroy();
  updateWin = null;
}

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

async function startDownload(info) {
  busy = true;
  createProgressWindow();
  paint(`Downloading version ${info && info.version ? info.version : ''}…`.trim(), null);
  try {
    await autoUpdater.downloadUpdate();
  } catch (err) {
    busy = false;
    closeProgressWindow();
    log('download failed:', err && err.message);
    dialog.showMessageBox({
      type: 'error',
      title: 'Update failed',
      message: 'Could not download the update.',
      detail: String((err && err.message) || err) + '\n\nThe app will keep working on the current version.',
      buttons: ['OK'],
    }).catch(() => {});
  }
}

function wireEvents() {
  autoUpdater.on('update-available', async (info) => {
    if (busy) return;
    log('update available:', info && info.version);
    const parent = hooks.getParent && hooks.getParent();
    const opts = {
      type: 'info',
      title: 'Update available',
      message: `Hanzla-GPT ${info && info.version ? info.version : ''} is available.`.replace(/\s+/g, ' ').trim(),
      detail: `You are on ${app.getVersion()}. The app will download the update and restart itself.`,
      buttons: ['Update now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    };
    const res = parent && !parent.isDestroyed()
      ? await dialog.showMessageBox(parent, opts)
      : await dialog.showMessageBox(opts);
    if (res.response === 0) startDownload(info);
  });

  autoUpdater.on('download-progress', (p) => {
    const pct = typeof p.percent === 'number' ? p.percent : null;
    const detail = p.total ? ` (${mb(p.transferred)} of ${mb(p.total)})` : '';
    paint(`Downloading… ${pct === null ? '' : Math.round(pct) + '%'}${detail}`.trim(), pct);
  });

  autoUpdater.on('update-downloaded', async (info) => {
    log('downloaded:', info && info.version);
    paint('Installing… the app will restart.', 100);
    // Let the renderer flush unsaved chats before the installer kills us.
    try { await hooks.beforeInstall(); } catch (err) { log('flush failed:', err && err.message); }
    setTimeout(() => {
      try {
        autoUpdater.quitAndInstall(false, true);
      } catch (err) {
        log('quitAndInstall failed:', err && err.message);
        closeProgressWindow();
        busy = false;
      }
    }, 400);
  });

  autoUpdater.on('error', (err) => {
    // Errors here are usually transient (offline, GitHub hiccup). Only make
    // noise if the user is actively watching a download.
    log('error:', err && err.message);
    if (busy) {
      busy = false;
      closeProgressWindow();
      dialog.showMessageBox({
        type: 'error',
        title: 'Update failed',
        message: 'The update could not be completed.',
        detail: String((err && err.message) || err),
        buttons: ['OK'],
      }).catch(() => {});
    }
  });
}

/* Manual check from the tray/menu: unlike the silent startup check, this
   always reports back, so the click never looks like it did nothing. */
async function checkNow() {
  if (!autoUpdater) {
    dialog.showMessageBox({
      type: 'info',
      title: 'Updates unavailable',
      message: 'Update checks only run in the installed app.',
      detail: 'This looks like a development run.',
      buttons: ['OK'],
    }).catch(() => {});
    return;
  }
  if (busy) return;
  try {
    const res = await autoUpdater.checkForUpdates();
    const remote = res && res.updateInfo && res.updateInfo.version;
    // 'update-available' fires on its own when there is one; only the
    // "nothing to do" case needs an answer here.
    if (!remote || remote === app.getVersion()) {
      dialog.showMessageBox({
        type: 'info',
        title: 'No updates',
        message: `Hanzla-GPT ${app.getVersion()} is up to date.`,
        buttons: ['OK'],
      }).catch(() => {});
    }
  } catch (err) {
    dialog.showMessageBox({
      type: 'error',
      title: 'Update check failed',
      message: 'Could not reach GitHub to check for updates.',
      detail: String((err && err.message) || err),
      buttons: ['OK'],
    }).catch(() => {});
  }
}

function init(options = {}) {
  hooks = { ...hooks, ...options };

  // electron-updater throws on an unpackaged app (no app-update.yml), and a
  // dev run should never try to replace itself anyway.
  if (!app.isPackaged) {
    log('dev run — update checks disabled');
    return;
  }

  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    log('electron-updater unavailable:', err && err.message);
    return;
  }

  autoUpdater.autoDownload = false;          // prompt first, then download
  autoUpdater.autoInstallOnAppQuit = false;  // we drive the install ourselves
  autoUpdater.logger = { info: log, warn: log, error: log, debug: () => {} };
  wireEvents();

  // Slightly delayed so it never competes with window creation on launch.
  setTimeout(() => { autoUpdater.checkForUpdates().catch((e) => log('startup check:', e && e.message)); }, 4000);
  setInterval(() => {
    if (!busy) autoUpdater.checkForUpdates().catch((e) => log('periodic check:', e && e.message));
  }, CHECK_INTERVAL_MS);
}

module.exports = { init, checkNow };
