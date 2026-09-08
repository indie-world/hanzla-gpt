'use strict';
/*
 * Proves the actual bug fix: a client that aborts must cancel the underlying
 * Ollama generation, not leave it running and blocking the (single-slot)
 * Ollama queue forever. This is what caused the real incident — two
 * abandoned headless requests silently piled up and blocked every
 * subsequent request, including unrelated trivial ones, until Ollama itself
 * was restarted.
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');

const CONTROL_PORT = 8771;
process.env.HGPT_CONTROL_PORT = String(CONTROL_PORT);
if (!process.env.HGPT_USER_DATA) {
  process.env.HGPT_USER_DATA = path.join(os.tmpdir(), 'hanzla-gpt-abortcheck');
}
require('../src/main.js');

const log = (...a) => console.log('[ab]', ...a);
let fails = 0;
const check = (ok, label, detail) => {
  log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '  — ' + detail : ''));
  if (!ok) fails++;
};

async function post(path, jsonBody, signal) {
  const res = await fetch('http://127.0.0.1:' + CONTROL_PORT + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(jsonBody),
    signal,
  });
  return res.json();
}

app.whenReady().then(async () => {
  const win = await new Promise((res) => {
    const t = () => { const w = BrowserWindow.getAllWindows()[0]; w ? res(w) : setTimeout(t, 200); };
    t();
  });
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  await new Promise((r) => setTimeout(r, 1500));

  // A prompt with no tools needed, but long enough to still be generating
  // when we abort it a couple of seconds in.
  const slowController = new AbortController();
  const slowPromise = post(
    '/command',
    { prompt: 'Write a very long, detailed 800 word essay about the history of the printing press.', model: 'llama3.2:3b' },
    slowController.signal
  ).catch((e) => ({ aborted: true, name: e.name }));

  await new Promise((r) => setTimeout(r, 3000));
  log('aborting the slow request client-side after 3s …');
  slowController.abort();
  const slowResult = await slowPromise;
  check(slowResult && (slowResult.aborted || slowResult.name === 'AbortError'), 'client-side abort resolved cleanly (no hang, no crash)');

  // The real test: Ollama must be free again immediately — not still busy
  // with the generation we just gave up on.
  const t0 = Date.now();
  const quick = await post('/command', { prompt: 'reply with just: ok', model: 'llama3.2:3b' });
  const quickSeconds = (Date.now() - t0) / 1000;
  log('quick follow-up took', quickSeconds.toFixed(1) + 's:', JSON.stringify(quick).slice(0, 150));

  check(quick.ok === true, 'follow-up request succeeded at all');
  check(quickSeconds < 30, 'follow-up was fast, proving the aborted request did not block the queue', quickSeconds.toFixed(1) + 's');

  // Confirm the app itself is still healthy after all this.
  const status = await (await fetch('http://127.0.0.1:' + CONTROL_PORT + '/status')).json();
  check(status.ok && status.ollama, 'app and Ollama both still healthy after the abort', JSON.stringify(status));

  log(fails === 0 ? 'ALL ABORT CHECKS PASSED' : fails + ' FAILED');
  app.exit(fails === 0 ? 0 : 1);
});
