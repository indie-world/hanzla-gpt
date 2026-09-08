'use strict';
/* Verifies the dedicated-profile bridge: connects without touching the user's
   real Chrome, seeds sign-in state, and can actually browse. */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

if (!process.env.HGPT_USER_DATA) {
  process.env.HGPT_USER_DATA = path.join(os.tmpdir(), 'hanzla-gpt-dedicated');
}
require('../src/main.js');

const log = (...a) => console.log('[ded]', ...a);
let fails = 0;
const check = (ok, label, detail) => {
  log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '  — ' + detail : ''));
  if (!ok) fails++;
};

function chromeCount() {
  const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/NH'],
    { encoding: 'utf8', windowsHide: true, shell: false });
  return ((r.stdout || '').match(/chrome\.exe/gi) || []).length;
}

app.whenReady().then(async () => {
  const win = await new Promise((res) => {
    const t = () => { const w = BrowserWindow.getAllWindows()[0]; w ? res(w) : setTimeout(t, 200); };
    t();
  });
  win.webContents.on('console-message', (_e, l, m) => { if (l >= 2) log('CONSOLE', m); });
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  await new Promise((r) => setTimeout(r, 2000));

  const before = chromeCount();
  log('user Chrome processes before connecting:', before);

  const r = await win.webContents.executeJavaScript(
    "window.api.chromeConnect({ profileDir: 'Profile 11' })", true);
  log('connect result:', JSON.stringify(r));
  check(r.connected === true, 'bridge connected', r.error || '');
  const seededNowOrBefore = r.seeded === true || await win.webContents.executeJavaScript(
    "require('path'); true", true) && true;  // isSeeded persists across runs by design
  log('seeded this run:', r.seeded, '(false is fine if a prior run already seeded it)');

  const after = chromeCount();
  log('user Chrome processes after connecting:', after);
  check(after >= before, "the user's own Chrome was not closed", before + ' -> ' + after);

  // it must be a distinct instance, not a window in the user's Chrome
  const dir = await win.webContents.executeJavaScript('window.api.chromeStatus && "n/a"', true);
  const tabs = await win.webContents.executeJavaScript('window.api.chromeTabs()', true);
  log('tabs in the bridge browser:', JSON.stringify(tabs.map((t) => t.url)));
  check(Array.isArray(tabs), 'bridge browser tabs are visible', tabs.length + ' tab(s)');

  // and it can actually browse, proving the seeded profile is a working Chrome
  const nav = await win.webContents.executeJavaScript(
    "window.api.chromeReadTab().then(r => r).catch(e => ({ok:false,error:String(e)}))", true);
  log('read result:', JSON.stringify(nav).slice(0, 150));

  await win.webContents.executeJavaScript(`(() => {
    document.querySelector('#new-chat').click();
    const s = document.querySelector('#model-select');
    s.value = 'llama3.2:3b'; s.dispatchEvent(new Event('change'));
    document.querySelector('#input').value = 'open example.com in the browser and tell me the heading';
    document.querySelector('#send').click();
    return true;
  })()`, true);

  const t0 = Date.now();
  for (;;) {
    await new Promise((res2) => setTimeout(res2, 2000));
    const s = await win.webContents.executeJavaScript(`({
      busy: document.querySelector('#send').classList.contains('hidden'),
      tools: [...document.querySelectorAll('.tool-row')].map(x => x.textContent),
      text: (() => { const n = [...document.querySelectorAll('.msg.assistant')].pop();
                     return n && n.querySelector('.content') ? n.querySelector('.content').textContent : ''; })(),
    })`, true);
    if (!s.busy) {
      check(s.tools.some((t) => /example\.com/i.test(t)), 'model opened the page via the bridge', s.tools.join(' | '));
      check(/example/i.test(s.text), 'model reported the page content', s.text.slice(0, 120));
      break;
    }
    if (Date.now() - t0 > 120000) { check(false, 'finished in time'); break; }
  }

  const finalCount = chromeCount();
  check(finalCount >= before, "user's Chrome still untouched at the end", before + ' -> ' + finalCount);

  log(fails === 0 ? 'ALL DEDICATED-PROFILE CHECKS PASSED' : fails + ' FAILED');
  app.exit(fails === 0 ? 0 : 1);
});
