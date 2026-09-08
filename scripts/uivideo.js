'use strict';
/* Fast UI-only check of the Video tab after fixing the sampling settings. */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');

if (!process.env.HGPT_USER_DATA) {
  process.env.HGPT_USER_DATA = path.join(os.tmpdir(), 'hanzla-gpt-uivideo');
}
require('../src/main.js');

const log = (...a) => console.log('[uv]', ...a);
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

  await win.webContents.executeJavaScript(
    "document.querySelector('.mode-tab[data-mode=\"video\"]').click()", true);
  await new Promise((r) => setTimeout(r, 800));

  const ui = await win.webContents.executeJavaScript(`({
    hasSteps: !!document.querySelector('#v-steps'),
    hasSeed: !!document.querySelector('#v-seed'),
    size: document.querySelector('#v-size').value,
    sizes: [...document.querySelectorAll('#v-size option')].map(o => o.value),
    estimate: document.querySelector('#v-estimate').textContent.trim(),
    params: videoParams(),
  })`, true);

  check(!ui.hasSteps, 'steps control hidden');
  check(!ui.hasSeed, 'seed control hidden');
  check(ui.params.steps === 30, 'steps pinned to 30', String(ui.params.steps));
  check(ui.params.seed > 0, 'seed randomised per run', String(ui.params.seed));
  check(ui.size === '480x272', 'default size is the one that produced clean output', ui.size);
  check(ui.sizes.includes('832x480'), 'native training size offered', ui.sizes.join(', '));
  log('estimate:', ui.estimate);
  check(/minutes/.test(ui.estimate), 'estimate shown in minutes');

  // second call must give a different seed
  const p2 = await win.webContents.executeJavaScript('videoParams()', true);
  check(p2.seed !== ui.params.seed, 'seed differs between runs');

  log(fails === 0 ? 'ALL UI VIDEO CHECKS PASSED' : fails + ' FAILED');
  app.exit(fails === 0 ? 0 : 1);
});
