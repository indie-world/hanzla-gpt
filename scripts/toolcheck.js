'use strict';
/* Verifies that the model can actually drive the browser through tool calls.
   Assumes a Chrome with --remote-debugging-port=9222 is already reachable. */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');

if (!process.env.HGPT_USER_DATA) {
  process.env.HGPT_USER_DATA = path.join(os.tmpdir(), 'hanzla-gpt-tool');
}
require('../src/main.js');

const MODEL = process.env.TOOL_MODEL || 'llama3.2:3b';
const log = (...a) => console.log('[tool]', ...a);
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

  // bridge must see the debug port
  const st = await win.webContents.executeJavaScript('window.api.chromeStatus()', true);
  log('bridge status:', JSON.stringify(st));
  check(st.connected === true, 'bridge sees the debugging port', st.browser || '');

  // direct navigation, independent of the model
  const nav = await win.webContents.executeJavaScript(
    "window.api.chromeReadTab().then(r => r).catch(e => ({ok:false,error:String(e)}))", true);
  log('initial tab:', JSON.stringify(nav).slice(0, 160));

  await win.webContents.executeJavaScript('refreshChromeUi()', true);
  const armed = await win.webContents.executeJavaScript(
    "({ connected: browserConnected, attachVisible: !document.querySelector('#attach-page').classList.contains('hidden') })", true);
  check(armed.connected, 'renderer knows the browser is connected');
  check(armed.attachVisible, 'page-attach button revealed');

  // Now the real test: ask the model in plain language to open a site.
  log('asking ' + MODEL + ' to open a page …');
  await win.webContents.executeJavaScript(`(() => {
    document.querySelector('#new-chat').click();
    const s = document.querySelector('#model-select');
    s.value = ${JSON.stringify(MODEL)};
    s.dispatchEvent(new Event('change'));
    document.querySelector('#input').value = 'Open example.com in the browser and tell me the heading on the page.';
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
      check(s.tools.length > 0, 'model invoked a browser tool', s.tools.join(' | '));
      check(s.tools.some((t) => /example\.com/i.test(t)), 'tool call targeted example.com');
      log('reply:', s.text.slice(0, 300));
      check(/example/i.test(s.text), 'reply mentions the page content', s.text.slice(0, 120));
      break;
    }
    if (Date.now() - t0 > 180000) { check(false, 'finished within 3 minutes'); break; }
  }

  // the tab really did open in Chrome
  const tabs = await win.webContents.executeJavaScript('window.api.chromeTabs()', true);
  tabs.forEach((t) => log('  tab:', t.title, '—', t.url));
  check(tabs.some((t) => /example\.com/i.test(t.url)), 'example.com is actually open in Chrome');

  log(fails === 0 ? 'ALL TOOL CHECKS PASSED' : fails + ' FAILED');
  app.exit(fails === 0 ? 0 : 1);
});
