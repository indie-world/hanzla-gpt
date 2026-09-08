'use strict';
/* Confirms that browser status polling spawns no visible console windows. */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

if (!process.env.HGPT_USER_DATA) {
  process.env.HGPT_USER_DATA = path.join(os.tmpdir(), 'hanzla-gpt-nocmd');
}
require('../src/main.js');

const log = (...a) => console.log('[nocmd]', ...a);
let fails = 0;
const check = (ok, label, detail) => {
  log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '  — ' + detail : ''));
  if (!ok) fails++;
};

function countProcess(name) {
  const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq ' + name, '/NH'],
    { encoding: 'utf8', windowsHide: true, shell: false });
  const out = typeof r.stdout === 'string' ? r.stdout : '';
  return (out.match(new RegExp(name.replace('.', '\\.'), 'gi')) || []).length;
}

app.whenReady().then(async () => {
  const win = await new Promise((res) => {
    const t = () => { const w = BrowserWindow.getAllWindows()[0]; w ? res(w) : setTimeout(t, 200); };
    t();
  });
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  await new Promise((r) => setTimeout(r, 2500));

  const baseCmd = countProcess('cmd.exe');
  const baseHost = countProcess('conhost.exe');
  log('baseline — cmd.exe:', baseCmd, ' conhost.exe:', baseHost);

  // hammer the path that used to shell out
  log('running 25 browser status checks …');
  for (let i = 0; i < 25; i++) {
    await win.webContents.executeJavaScript('window.api.chromeStatus()', true);
  }

  const afterCmd = countProcess('cmd.exe');
  const afterHost = countProcess('conhost.exe');
  log('after    — cmd.exe:', afterCmd, ' conhost.exe:', afterHost);

  check(afterCmd <= baseCmd, 'no new cmd.exe windows spawned', baseCmd + ' -> ' + afterCmd);
  check(afterHost <= baseHost + 1, 'no burst of console hosts', baseHost + ' -> ' + afterHost);

  // the cache should collapse 25 calls into very few real lookups
  const t0 = Date.now();
  for (let i = 0; i < 25; i++) {
    await win.webContents.executeJavaScript('window.api.chromeStatus()', true);
  }
  const ms = Date.now() - t0;
  log('25 further checks took', ms + 'ms');
  check(ms < 8000, 'status checks are cheap enough not to stall startup', ms + 'ms');

  log(fails === 0 ? 'ALL NO-CMD CHECKS PASSED' : fails + ' FAILED');
  app.exit(fails === 0 ? 0 : 1);
});
