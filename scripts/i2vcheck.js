'use strict';
/* Verifies the Video tab end to end: engine list, reference-photo upload,
   image-to-video generation, and that the file lands in the save folder. */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

if (!process.env.HGPT_USER_DATA) {
  process.env.HGPT_USER_DATA = path.join(os.tmpdir(), 'hanzla-gpt-i2v');
}
require('../src/main.js');

const REF_IMAGE = 'D:\\AI\\ComfyUI_windows_portable\\ComfyUI\\input\\hanzla_ref_test.png';

const log = (...a) => console.log('[i2v]', ...a);
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
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) log('CONSOLE', msg); });
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  await new Promise((r) => setTimeout(r, 2500));

  await win.webContents.executeJavaScript(
    "document.querySelector('.mode-tab[data-mode=\"video\"]').click()", true);
  await new Promise((r) => setTimeout(r, 1200));

  // engines
  const engines = await win.webContents.executeJavaScript('window.api.comfyEngines()', true);
  log('engines on disk:', JSON.stringify(engines));
  check(engines.wan22 === true, 'WAN 2.2 available');
  check(engines.wan === true, 'WAN 2.1 available');
  check(engines.ltx === undefined, 'LTX fully removed');

  const opts = await win.webContents.executeJavaScript(
    "[...document.querySelectorAll('#v-engine option')].map(o => o.textContent + (o.disabled ? ' [disabled]' : ''))", true);
  opts.forEach((o) => log('  option:', o));
  check(opts.length === 2 && !opts.some((o) => /LTX/i.test(o)), 'engine list shows only WAN models');

  // reference photo field
  const imgUi = await win.webContents.executeJavaScript(`({
    hasField: !!document.querySelector('#v-image'),
    pickEnabled: !document.querySelector('#v-image-pick').disabled,
  })`, true);
  check(imgUi.hasField, 'reference photo field present');
  check(imgUi.pickEnabled, 'photo picker enabled for WAN 2.2');

  // engine
  if (!(await win.webContents.executeJavaScript('window.api.comfyStatus()', true)).running) {
    log('starting engine…');
    const st = await win.webContents.executeJavaScript('window.api.comfyStart()', true);
    check(st.running, 'engine started', st.error || '');
  }

  // upload path
  const up = await win.webContents.executeJavaScript(
    `window.api.uploadImage(${JSON.stringify(REF_IMAGE)})`, true);
  log('uploaded:', JSON.stringify(up));
  check(!!up.name, 'reference photo uploads to the engine', up.name);

  // image-to-video through the UI
  await win.webContents.executeJavaScript(`(() => {
    setReferenceImage(${JSON.stringify(REF_IMAGE)});
    document.querySelector('#v-engine').value = 'wan22';
    document.querySelector('#v-prompt').value = 'the person smiles and slowly turns their head, soft natural light, photorealistic';
    document.querySelector('#v-size').value = '320x192';
    document.querySelector('#v-length').value = '25';
    document.querySelector('#v-steps').value = '10';
    document.querySelector('#v-seed').value = String(Math.floor(Math.random()*100000));
    ['#v-engine','#v-size','#v-length','#v-steps'].forEach(x => document.querySelector(x).dispatchEvent(new Event('input')));
    document.querySelector('#v-generate').click();
    return true;
  })()`, true);

  const est = await win.webContents.executeJavaScript(
    "document.querySelector('#v-estimate').textContent", true);
  check(/Animating your photo/.test(est), 'UI reports image-to-video mode', est.slice(0, 100));

  const t0 = Date.now();
  let lastLog = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, 2500));
    const st = await win.webContents.executeJavaScript(`({
      busy: document.querySelector('#v-generate').disabled,
      text: document.querySelector('#v-progress-text').textContent,
      err: document.querySelector('#v-error').classList.contains('hidden') ? '' : document.querySelector('#v-error').textContent,
    })`, true);
    if (!st.busy) {
      check(!st.err, 'image-to-video generation succeeded', st.err || st.text);
      log('result:', st.text);
      break;
    }
    if (Date.now() - lastLog > 30000) {
      lastLog = Date.now();
      log('  ' + Math.round((Date.now() - t0) / 1000) + 's — ' + st.text);
    }
    if (Date.now() - t0 > 900000) { check(false, 'finished within 15 min'); break; }
  }

  const dirInfo = await win.webContents.executeJavaScript('window.api.getVideoDir()', true);
  const saved = await win.webContents.executeJavaScript('window.api.listVideos()', true);
  saved.forEach((f) => log('  saved:', f.file, Math.round(f.bytes / 1024) + ' KB'));
  check(saved.length >= 1, 'clip written to the save folder', saved.length + ' file(s)');
  check(/^D:/i.test(dirInfo.dir), 'save folder on D:', dirInfo.dir);

  log(fails === 0 ? 'ALL I2V CHECKS PASSED' : fails + ' FAILED');
  app.exit(fails === 0 ? 0 : 1);
});
