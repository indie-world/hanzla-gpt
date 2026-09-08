'use strict';
/* Standalone: launches the throwaway Chrome with --load-extension and reads
   chrome://extensions to see the actual error Chrome reports, if any. */
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const WebSocket = require(path.join(__dirname, '..', 'node_modules', 'ws'));

const EXT_DIR = path.join(__dirname, '..', 'extension');
const PROFILE = path.join(os.tmpdir(), 'hgpt-extdiag-chrome');
const CHROME_BIN = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

function get(url) { return fetch(url).then((r) => r.json()); }

function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 10000);
    ws.on('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })));
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (m.result && m.result.exceptionDetails) reject(new Error(JSON.stringify(m.result.exceptionDetails)));
      else resolve(m.result && m.result.result && m.result.result.value);
    });
    ws.on('error', reject);
  });
}

(async () => {
  console.log('[diag] extension dir:', EXT_DIR);
  const fs = require('node:fs');
  console.log('[diag] manifest exists:', fs.existsSync(path.join(EXT_DIR, 'manifest.json')));
  console.log('[diag] manifest contents:', fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));

  const child = spawn(CHROME_BIN, [
    '--user-data-dir=' + PROFILE,
    '--load-extension=' + EXT_DIR,
    '--remote-debugging-port=9334',
    '--no-first-run', '--no-default-browser-check',
    'chrome://extensions/',
  ], { detached: true, stdio: 'ignore' });
  child.unref();

  await new Promise((r) => setTimeout(r, 5000));

  const list = await get('http://127.0.0.1:9334/json/list');
  console.log('[diag] targets:', JSON.stringify(list.map((t) => ({ type: t.type, title: t.title, url: t.url })), null, 2));

  const page = list.find((t) => t.type === 'page' && t.url.startsWith('chrome://extensions'));
  if (page) {
    try {
      const text = await evaluate(page.webSocketDebuggerUrl, 'document.body.innerText');
      console.log('[diag] extensions page text (first 3000 chars):');
      console.log(text.slice(0, 3000));
    } catch (e) {
      console.log('[diag] could not read extensions page:', e.message);
    }
  } else {
    console.log('[diag] no chrome://extensions page target found');
  }

  process.exit(0);
})().catch((e) => { console.log('[diag] FATAL', e.message); process.exit(1); });
