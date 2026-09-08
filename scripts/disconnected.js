'use strict';
/* With no browser connected, asking to open a page must produce a
   "connect it in Settings" answer — never "I cannot browse". */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');

if (!process.env.HGPT_USER_DATA) {
  process.env.HGPT_USER_DATA = path.join(os.tmpdir(), 'hanzla-gpt-disc');
}
require('../src/main.js');

const MODEL = process.env.TOOL_MODEL || 'llama3.2:3b';
const log = (...a) => console.log('[disc]', ...a);
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

  const st = await win.webContents.executeJavaScript('window.api.chromeStatus()', true);
  check(st.connected === false, 'starting from a disconnected browser', JSON.stringify(st));

  log('asking ' + MODEL + ' to open a page while disconnected …');
  await win.webContents.executeJavaScript(`(() => {
    document.querySelector('#new-chat').click();
    const s = document.querySelector('#model-select');
    s.value = ${JSON.stringify(MODEL)};
    s.dispatchEvent(new Event('change'));
    document.querySelector('#input').value = 'open a web page www.clackzilla.com in the connected browser';
    document.querySelector('#send').click();
    return true;
  })()`, true);

  const t0 = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    const s = await win.webContents.executeJavaScript(`({
      busy: document.querySelector('#send').classList.contains('hidden'),
      tools: [...document.querySelectorAll('.tool-row')].map(r => r.textContent),
      text: (() => { const n = [...document.querySelectorAll('.msg.assistant')].pop();
                     return n && n.querySelector('.content') ? n.querySelector('.content').textContent : ''; })(),
    })`, true);
    if (!s.busy) {
      log('tool rows:', JSON.stringify(s.tools));
      log('reply:', s.text.slice(0, 400));
      check(s.tools.length > 0, 'model still attempted the browser tool', s.tools.join(' | '));
      check(/settings|connect/i.test(s.text), 'reply points at Settings / Connect', s.text.slice(0, 160));
      check(!/i (don'?t|do not) have the (ability|capability)/i.test(s.text),
        'reply does NOT claim it cannot browse');
      break;
    }
    if (Date.now() - t0 > 180000) { check(false, 'finished within 3 minutes'); break; }
  }

  log(fails === 0 ? 'ALL DISCONNECTED CHECKS PASSED' : fails + ' FAILED');
  app.exit(fails === 0 ? 0 : 1);
});
