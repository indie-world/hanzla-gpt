'use strict';
/* Verifies the video save-location field and engine availability list. */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');

if (!process.env.HGPT_USER_DATA) {
  process.env.HGPT_USER_DATA = path.join(os.tmpdir(), 'hanzla-gpt-dircheck');
}
require('../src/main.js');

const log = (...a) => console.log('[dir]', ...a);
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
  await new Promise((r) => setTimeout(r, 2500));

  await win.webContents.executeJavaScript(
    "document.querySelector('.mode-tab[data-mode=\"video\"]').click()", true);
  await new Promise((r) => setTimeout(r, 1500));

  const info = await win.webContents.executeJavaScript('window.api.getVideoDir()', true);
  log('dir info:', JSON.stringify(info));
  check(/^D:/i.test(info.dir), 'default save path is on D:', info.dir);
  check(info.writable, 'save path is writable');

  const ui = await win.webContents.executeJavaScript(`({
    shown: document.querySelector('#v-dir').value,
    note: document.querySelector('#v-dir-note').textContent,
    hasChange: !!document.querySelector('#v-dir-change'),
    hasOpen: !!document.querySelector('#v-dir-open'),
  })`, true);
  check(ui.shown === info.dir, 'path displayed in the Video tab', ui.shown);
  check(ui.hasChange && ui.hasOpen, 'Change and Open buttons present');
  check(ui.note.length > 5, 'helper note shown', ui.note);

  const engines = await win.webContents.executeJavaScript('window.api.comfyEngines()', true);
  log('engines on disk:', JSON.stringify(engines));
  check(engines.ltx === true, 'LTX-Video available');

  const opts = await win.webContents.executeJavaScript(
    "[...document.querySelectorAll('#v-engine option')].map(o => o.textContent + (o.disabled ? ' [disabled]' : ''))", true);
  opts.forEach((o) => log('  engine option:', o));
  check(opts.length === 2, 'two engines listed');

  log(fails === 0 ? 'ALL DIR CHECKS PASSED' : fails + ' FAILED');
  app.exit(fails === 0 ? 0 : 1);
});
