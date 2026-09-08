'use strict';
/*
 * End-to-end proof of the extension bridge:
 *  1. Start the real app (isolated profile) which hosts the WS server.
 *  2. Launch a THROWAWAY Chrome (its own temp profile) with --load-extension
 *     pointed at the real extension folder — simulating "any already-open
 *     Chrome, any profile" without touching the user's real browser.
 *  3. Confirm the extension links automatically, with no app-initiated spawn.
 *  4. Drive a real chat message through the model and confirm it can open a
 *     page and read it back through that browser.
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');

const EXT_PORT = 8766;   // isolated port so this never collides with a real running app
process.env.HGPT_EXT_PORT = String(EXT_PORT);
if (!process.env.HGPT_USER_DATA) {
  process.env.HGPT_USER_DATA = path.join(os.tmpdir(), 'hanzla-gpt-extbridge');
}
require('../src/main.js');

const EXT_DIR = path.join(__dirname, '..', 'extension');
const CHROME_PROFILE = path.join(os.tmpdir(), 'hgpt-extbridge-chrome');
const CHROME_BIN = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const log = (...a) => console.log('[ext]', ...a);
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

  const st0 = await win.webContents.executeJavaScript('window.api.extStatus()', true);
  check(st0.connected === false, 'starts with no browser linked', JSON.stringify(st0));

  const before = chromeCount();
  log("real Chrome's process count before this test's throwaway browser:", before);

  // The extension's WS URL is hardcoded to 8765 in background.js for real use,
  // but this test's server runs on 8766 to stay isolated — patch a copy so the
  // throwaway browser actually reaches this test's server.
  const fs = require('node:fs');
  const testExtDir = path.join(os.tmpdir(), 'hgpt-extbridge-extcopy');
  fs.rmSync(testExtDir, { recursive: true, force: true });
  fs.cpSync(EXT_DIR, testExtDir, { recursive: true });
  const bgPath = path.join(testExtDir, 'background.js');
  fs.writeFileSync(bgPath, fs.readFileSync(bgPath, 'utf8').replace('const PORT = 8765;', `const PORT = ${EXT_PORT};`));

  log('launching a throwaway Chrome with the extension loaded …');
  const child = spawn(CHROME_BIN, [
    '--user-data-dir=' + CHROME_PROFILE,
    '--load-extension=' + testExtDir,
    '--remote-debugging-port=9333',   // diagnostics only; safe, this is not the default profile
    '--no-first-run', '--no-default-browser-check',
    'about:blank',
  ], { detached: true, stdio: 'ignore' });
  child.unref();

  let linked = false;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const st = await win.webContents.executeJavaScript('window.api.extStatus()', true);
    if (st.connected) { linked = true; break; }
  }

  if (!linked) {
    try {
      const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
      log('CDP targets in throwaway chrome:', JSON.stringify(list.map((t) => ({ type: t.type, title: t.title, url: t.url }))));
      const sw = list.find((t) => t.type === 'service_worker');
      if (sw && sw.webSocketDebuggerUrl) {
        const WebSocket = require('ws');
        const ws = new WebSocket(sw.webSocketDebuggerUrl);
        const logs = [];
        ws.on('open', () => {
          ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
        });
        ws.on('message', (d) => {
          const m = JSON.parse(d.toString());
          if (m.method === 'Runtime.consoleAPICalled') {
            logs.push(m.params.args.map((a) => a.value || a.description).join(' '));
          }
        });
        await new Promise((r) => setTimeout(r, 3000));
        log('service worker console output:', JSON.stringify(logs));
        ws.close();
      } else {
        log('no service_worker target found — extension may have failed to load at all');
      }
    } catch (e) {
      log('diagnostic fetch failed:', e.message);
    }
  }

  check(linked, 'throwaway browser auto-linked via the extension, no user action needed');

  const after = chromeCount();
  log("real Chrome's process count after linking:", after);
  check(after >= before, "user's real Chrome was not touched", before + ' -> ' + after);

  const tabs = await win.webContents.executeJavaScript('window.api.extTabs()', true);
  log('tabs seen through the link:', JSON.stringify(tabs.map((t) => t.url)));
  check(Array.isArray(tabs) && tabs.length > 0, 'tabs visible through the extension');

  // drive a real chat message end to end
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
    await new Promise((r) => setTimeout(r, 2000));
    const s = await win.webContents.executeJavaScript(`({
      busy: document.querySelector('#send').classList.contains('hidden'),
      tools: [...document.querySelectorAll('.tool-row')].map(x => x.textContent),
      text: (() => { const n = [...document.querySelectorAll('.msg.assistant')].pop();
                     return n && n.querySelector('.content') ? n.querySelector('.content').textContent : ''; })(),
    })`, true);
    if (!s.busy) {
      log('tool rows:', JSON.stringify(s.tools));
      log('reply:', s.text.slice(0, 300));
      check(s.tools.some((t) => /example\.com/i.test(t)), 'model opened the page through the extension link');
      check(/example/i.test(s.text), 'model reported the real page content', s.text.slice(0, 150));
      break;
    }
    if (Date.now() - t0 > 120000) { check(false, 'finished within 2 minutes'); break; }
  }

  // also verify the read_current_page / attach-page path works
  const attach = await win.webContents.executeJavaScript(
    "window.api.extReadTab().then(r => r).catch(e => ({ok:false,error:String(e)}))", true);
  log('attach-page read result:', JSON.stringify(attach).slice(0, 150));
  check(attach.ok === true, 'attach-current-page also works through the link');

  const finalReal = chromeCount();
  check(finalReal >= before, "user's Chrome still untouched at the end", before + ' -> ' + finalReal);

  log(fails === 0 ? 'ALL EXTENSION BRIDGE CHECKS PASSED' : fails + ' FAILED');
  app.exit(fails === 0 ? 0 : 1);
});
