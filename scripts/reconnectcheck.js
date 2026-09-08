'use strict';
/* Points at the REAL running app's userData/port by inspecting the live
   process rather than spawning a new one, since we must not disturb the
   user's already-linked browser. This just checks the Settings UI renders
   correctly against whatever the real app currently reports. */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');

// Isolated instance purely to render the Settings UI and confirm the button
// exists and wires up; it will report "not linked" since it's a separate
// process from the user's real app, which is expected and fine here.
if (!process.env.HGPT_USER_DATA) {
  process.env.HGPT_USER_DATA = path.join(os.tmpdir(), 'hanzla-gpt-reconnectui');
}
require('../src/main.js');

const log = (...a) => console.log('[rc]', ...a);
let fails = 0;
const check = (ok, label, detail) => {
  log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '  — ' + detail : ''));
  if (!ok) fails++;
};

app.whenReady().then(async () => {
  const win = await new Promise((res) => {
    const t = () => { const w = BrowserWindow.getAllWindows()[0]; w ? res(w) : setTimeout(t, 200); };
    t();
  });
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  await new Promise((r) => setTimeout(r, 2000));

  await win.webContents.executeJavaScript("document.querySelector('#open-settings').click()", true);
  await new Promise((r) => setTimeout(r, 800));

  const ui = await win.webContents.executeJavaScript(`({
    hasReconnect: !!document.querySelector('#ext-reconnect'),
    hasStatus: !!document.querySelector('#ext-status'),
    hasOpenFolder: !!document.querySelector('#ext-open-folder'),
    statusText: document.querySelector('#ext-status .txt').textContent,
  })`, true);
  log('ui:', JSON.stringify(ui));
  check(ui.hasReconnect, 'Reconnect button present in Settings');
  check(ui.hasStatus, 'status indicator present');
  check(ui.hasOpenFolder, 'Open extension folder button present');

  // click it and confirm it doesn't throw / disables briefly
  const clickResult = await win.webContents.executeJavaScript(`(async () => {
    const btn = document.querySelector('#ext-reconnect');
    btn.click();
    const wasDisabled = btn.disabled;
    await new Promise(r => setTimeout(r, 1500));
    return { wasDisabled, nowEnabled: !btn.disabled, statusAfter: document.querySelector('#ext-status .txt').textContent };
  })()`, true);
  log('click result:', JSON.stringify(clickResult));
  check(clickResult.wasDisabled, 'button disables immediately on click');
  check(clickResult.nowEnabled, 'button re-enables after the check completes');

  log(fails === 0 ? 'ALL RECONNECT UI CHECKS PASSED' : fails + ' FAILED');
  app.exit(fails === 0 ? 0 : 1);
});
