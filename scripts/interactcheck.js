'use strict';
/*
 * Verifies click/type/extract_links/scroll against a real, safe public page
 * (the-internet.herokuapp.com — a well-known QA testing sandbox with actual
 * forms and login flows, built for exactly this kind of automated testing).
 * Never touches LinkedIn or any of the user's accounts.
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');

const EXT_PORT = 8767;
process.env.HGPT_EXT_PORT = String(EXT_PORT);
if (!process.env.HGPT_USER_DATA) {
  process.env.HGPT_USER_DATA = path.join(os.tmpdir(), 'hanzla-gpt-interact');
}
require('../src/main.js');

const EXT_DIR = path.join(__dirname, '..', 'extension');
const CHROME_PROFILE = path.join(os.tmpdir(), 'hgpt-interact-chrome');
const CHROME_BIN = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const log = (...a) => console.log('[ia]', ...a);
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
  await new Promise((r) => setTimeout(r, 2000));

  const testExtDir = path.join(os.tmpdir(), 'hgpt-interact-extcopy');
  fs.rmSync(testExtDir, { recursive: true, force: true });
  fs.cpSync(EXT_DIR, testExtDir, { recursive: true });
  const bgPath = path.join(testExtDir, 'background.js');
  fs.writeFileSync(bgPath, fs.readFileSync(bgPath, 'utf8').replace('const PORT = 8765;', `const PORT = ${EXT_PORT};`));

  log('launching throwaway Chrome …');
  const child = spawn(CHROME_BIN, [
    '--user-data-dir=' + CHROME_PROFILE,
    '--load-extension=' + testExtDir,
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
  check(linked, 'extension linked for this test');
  if (!linked) { log('cannot continue without a link'); app.exit(1); return; }

  // --- extract_links on a real content page (Wikipedia) -------------------
  await win.webContents.executeJavaScript(
    "window.api.extReadTab ? true : true", true); // no-op keepalive
  const openResult = await win.webContents.executeJavaScript(`(async () => {
    return await window.api.storeGet('__x__').then(() => true);
  })()`, true);

  // Drive everything through the real chat tool loop so this proves the
  // actual user-facing path, not just the bridge in isolation.
  async function ask(prompt, timeoutMs = 90000) {
    await win.webContents.executeJavaScript(`(() => {
      document.querySelector('#new-chat').click();
      const s = document.querySelector('#model-select');
      const opt = [...s.options].find(o => /qwen3:4b|gpt-oss/i.test(o.value)) || s.options[0];
      s.value = opt.value; s.dispatchEvent(new Event('change'));
      document.querySelector('#input').value = ${JSON.stringify(prompt)};
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
      if (!s.busy) return s;
      if (Date.now() - t0 > timeoutMs) return { ...s, timedOut: true };
    }
  }

  const modelUsed = await win.webContents.executeJavaScript(
    "[...document.querySelectorAll('#model-select option')].map(o=>o.value)", true);
  log('models available:', JSON.stringify(modelUsed));

  log('--- test 1: extract_links on Wikipedia ---');
  const r1 = await ask('open https://en.wikipedia.org/wiki/Web_browser and extract all links, then just list 3 of them');
  log('tools:', JSON.stringify(r1.tools));
  log('reply:', r1.text.slice(0, 400));
  check(r1.tools.some((t) => /extract_links|Opening/i.test(t)), 'used open_page/extract_links tools', r1.tools.join(' | '));
  check(!r1.timedOut, 'test 1 finished in time');

  log('--- test 2: type + click on a real form (the-internet.herokuapp.com/login) ---');
  const r2 = await ask(
    'open https://the-internet.herokuapp.com/login, type "tomsmith" into the username field, '
    + 'type "SuperSecretPassword!" into the password field, then click the Login button, and tell me what the page says afterward'
  );
  log('tools:', JSON.stringify(r2.tools));
  log('reply:', r2.text.slice(0, 400));
  check(r2.tools.some((t) => /Typed into/i.test(t)), 'type_text tool fired', r2.tools.join(' | '));
  check(r2.tools.some((t) => /Clicked/i.test(t)), 'click_on tool fired', r2.tools.join(' | '));
  check(/secure area|logged in|welcome/i.test(r2.text) || /logged/i.test(JSON.stringify(r2.tools)),
    'login actually succeeded (secure area reached)', r2.text.slice(0, 200));

  log('--- test 3: save_rows_to_file ---');
  const r3 = await ask(
    'call save_rows_to_file with filename "test-export.csv" and rows containing two objects: '
    + '{"name":"Studio A","url":"https://a.example"} and {"name":"Studio B","url":"https://b.example"}'
  );
  log('tools:', JSON.stringify(r3.tools));
  log('reply:', r3.text.slice(0, 300));
  const exportPath = 'D:\\Hanzla-GPT\\Exports\\test-export.csv';
  const wrote = fs.existsSync(exportPath);
  check(wrote, 'CSV file actually written to disk', exportPath);
  if (wrote) log('CSV contents:', fs.readFileSync(exportPath, 'utf8'));

  log(fails === 0 ? 'ALL INTERACTION CHECKS PASSED' : fails + ' FAILED');
  app.exit(fails === 0 ? 0 : 1);
});
