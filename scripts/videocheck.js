'use strict';
/* Drives the Video tab through the UI and generates a real clip. */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

if (!process.env.HGPT_USER_DATA) {
  process.env.HGPT_USER_DATA = path.join(os.tmpdir(), 'hanzla-gpt-videocheck');
}
require('../src/main.js');

const log = (...a) => console.log('[vid]', ...a);
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
  win.webContents.on('console-message', (_e, lvl, msg, line, src) => {
    if (lvl >= 2) log('CONSOLE', msg, '(' + String(src).split(/[\\/]/).pop() + ':' + line + ')');
  });
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  await new Promise((r) => setTimeout(r, 3000));

  // switch to the Video tab
  const shown = await win.webContents.executeJavaScript(`(() => {
    document.querySelector('.mode-tab[data-mode="video"]').click();
    return {
      videoVisible: !document.querySelector('#video-main').classList.contains('hidden'),
      chatHidden: document.querySelector('#main').classList.contains('hidden'),
      estimate: document.querySelector('#v-estimate').textContent.trim(),
    };
  })()`, true);
  check(shown.videoVisible && shown.chatHidden, 'video tab switches views');
  check(shown.estimate.length > 40, 'time estimate shown', shown.estimate.slice(0, 110));

  // engine status
  const eng = await win.webContents.executeJavaScript('window.api.comfyStatus()', true);
  log('engine:', JSON.stringify(eng));
  check(eng.installed, 'ComfyUI detected as installed');
  if (!eng.running) {
    log('starting engine…');
    const st = await win.webContents.executeJavaScript('window.api.comfyStart()', true);
    check(st.running, 'engine started', st.error || '');
  } else {
    check(true, 'engine already running', eng.device);
  }

  // Two runs back to back: the second one is what used to crash the engine when
  // ComfyUI kept the previous checkpoint cached.
  const PROMPTS = [
    'A single red balloon drifting upward against a clear blue sky',
    'Steam rising from a hot cup of coffee on a wooden table',
  ];

  for (let run = 0; run < PROMPTS.length; run++) {
    log('--- generation ' + (run + 1) + ' of ' + PROMPTS.length + ' ---');
    await win.webContents.executeJavaScript(`(() => {
      document.querySelector('#v-prompt').value = ${JSON.stringify(PROMPTS[run])};
      document.querySelector('#v-size').value = '384x256';
      document.querySelector('#v-length').value = '25';
      document.querySelector('#v-steps').value = '12';
      document.querySelector('#v-seed').value = '${run + 7}';
      ['#v-size','#v-length','#v-steps'].forEach(s => document.querySelector(s).dispatchEvent(new Event('input')));
      document.querySelector('#v-generate').click();
      return true;
    })()`, true);

    const t0 = Date.now();
    let lastLog = 0;
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      const st = await win.webContents.executeJavaScript(`({
        busy: document.querySelector('#v-generate').disabled,
        text: document.querySelector('#v-progress-text').textContent,
        err: document.querySelector('#v-error').classList.contains('hidden') ? '' : document.querySelector('#v-error').textContent,
      })`, true);
      if (!st.busy) {
        check(!st.err, 'generation ' + (run + 1) + ' completed without error', st.err || st.text);
        log('  finished:', st.text);
        break;
      }
      if (Date.now() - lastLog > 25000) {
        lastLog = Date.now();
        log('  ' + Math.round((Date.now() - t0) / 1000) + 's — ' + st.text);
      }
      if (Date.now() - t0 > 900000) { check(false, 'generation ' + (run + 1) + ' finished within 15 min'); break; }
    }
  }

  const stillUp = await win.webContents.executeJavaScript('window.api.comfyStatus()', true);
  check(stillUp.running, 'engine survived both generations');

  // Files must land in the configured save folder.
  const dirInfo = await win.webContents.executeJavaScript('window.api.getVideoDir()', true);
  const saved = await win.webContents.executeJavaScript('window.api.listVideos()', true);
  log('save dir:', dirInfo.dir);
  saved.forEach((f) => log('  file:', f.file, Math.round(f.bytes / 1024) + ' KB'));
  check(saved.length >= 2, 'both clips written to the save folder', saved.length + ' file(s)');
  check(saved.every((f) => f.bytes > 2000), 'files are non-trivial in size');
  check(/^D:/i.test(dirInfo.dir), 'save folder is on D:', dirInfo.dir);

  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'videocheck-shot.png'), img.toPNG());
  log('screenshot -> scripts/videocheck-shot.png');

  log(fails === 0 ? 'ALL VIDEO CHECKS PASSED' : fails + ' FAILED');
  app.exit(fails === 0 ? 0 : 1);
});
