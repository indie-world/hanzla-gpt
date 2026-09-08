'use strict';
/* Checks the Chrome bridge without disturbing a running Chrome:
   profile discovery, status reporting, and UI wiring only. */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');

if (!process.env.HGPT_USER_DATA) {
  process.env.HGPT_USER_DATA = path.join(os.tmpdir(), 'hanzla-gpt-bridge');
}
require('../src/main.js');

const log = (...a) => console.log('[br]', ...a);
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
  win.webContents.on('console-message', (_e, l, m) => { if (l >= 2) log('CONSOLE', m); });
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  await new Promise((r) => setTimeout(r, 2500));

  // ws must be loadable from the app, or the bridge is dead on arrival
  const wsOk = await win.webContents.executeJavaScript(
    "(async () => { try { const r = await window.api.chromeStatus(); return !!r; } catch (e) { return 'ERR:' + e.message; } })()", true);
  check(wsOk === true, 'bridge module loads (ws present)', String(wsOk));

  const profiles = await win.webContents.executeJavaScript('window.api.chromeProfiles()', true);
  check(profiles.length > 0, 'Chrome profiles discovered', profiles.length + ' profiles');
  // Which signed-in Chrome profile to expect is machine-specific; set
  // BRIDGECHECK_PROFILE to a substring of your own profile's email.
  const wanted = process.env.BRIDGECHECK_PROFILE || '@';
  const indie = profiles.find((p) => p.email && p.email.toLowerCase().includes(wanted.toLowerCase()));
  check(!!indie, 'a signed-in Chrome profile was found', indie ? indie.dir + ' = ' + indie.name : 'not found');

  const st = await win.webContents.executeJavaScript('window.api.chromeStatus()', true);
  log('status:', JSON.stringify(st));
  check(typeof st.connected === 'boolean', 'status reports a connection state');
  check(st.chromeRunning === true, 'detects that Chrome is currently running');
  check(st.connected === false, 'correctly reports NOT connected (no debug port yet)');

  // settings UI
  await win.webContents.executeJavaScript("document.querySelector('#open-settings').click()", true);
  await new Promise((r) => setTimeout(r, 1200));
  const ui = await win.webContents.executeJavaScript(`({
    options: document.querySelectorAll('#chrome-profile option').length,
    selected: document.querySelector('#chrome-profile').value,
    selectedText: document.querySelector('#chrome-profile').selectedOptions[0]
      ? document.querySelector('#chrome-profile').selectedOptions[0].textContent : '',
    statusText: document.querySelector('#chrome-status .txt').textContent,
    hasConnect: !!document.querySelector('#chrome-connect'),
    attachHidden: document.querySelector('#attach-page').classList.contains('hidden'),
  })`, true);
  check(ui.options > 5, 'profile picker populated', ui.options + ' options');
  check(ui.selectedText.trim().length > 0, 'profile picker defaults to a real profile', ui.selectedText);
  check(ui.hasConnect, 'Connect button present');
  check(ui.attachHidden, 'page-attach button hidden while disconnected');
  log('status text:', ui.statusText);

  log(fails === 0 ? 'ALL BRIDGE CHECKS PASSED' : fails + ' FAILED');
  app.exit(fails === 0 ? 0 : 1);
});
