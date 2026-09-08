'use strict';
/*
 * Directly answers "where does the file actually get saved": boots the real
 * app (isolated profile, does not touch the user's real chat history), asks
 * the model to call save_rows_to_file explicitly, then reports the exact
 * absolute path where it landed — or proves it never called the tool at all.
 *
 * save_rows_to_file has no browser dependency, so this sidesteps the
 * extension-linking flakiness entirely and isolates one question: does the
 * model actually invoke the save tool, and where does the app put the file.
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

if (!process.env.HGPT_USER_DATA) {
  process.env.HGPT_USER_DATA = path.join(os.tmpdir(), 'hanzla-gpt-savepath');
}
require('../src/main.js');

const log = (...a) => console.log('[sp]', ...a);

app.whenReady().then(async () => {
  const win = await new Promise((res) => {
    const t = () => { const w = BrowserWindow.getAllWindows()[0]; w ? res(w) : setTimeout(t, 200); };
    t();
  });
  win.webContents.on('console-message', (_e, l, m) => { if (l >= 2) log('CONSOLE', m); });
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  await new Promise((r) => setTimeout(r, 2000));

  // Match the context-length fix already recommended, so this run reflects
  // the setup the user should actually be using, not the old 2048 default.
  await win.webContents.executeJavaScript('settings.numCtx = 8192; saveSoon();', true);

  const models = await win.webContents.executeJavaScript(
    "[...document.querySelectorAll('#model-select option')].map(o => o.value)", true);
  log('available models:', JSON.stringify(models));
  const model = models.find((m) => /qwen3:4b/i.test(m)) || models[0];
  log('using model:', model);

  await win.webContents.executeJavaScript(`(() => {
    document.querySelector('#new-chat').click();
    const s = document.querySelector('#model-select');
    s.value = ${JSON.stringify(model)}; s.dispatchEvent(new Event('change'));
    document.querySelector('#input').value =
      'Call the save_rows_to_file tool right now with filename "diagnostic-test.csv" and rows: ' +
      '[{"name":"Test Studio A","url":"https://a.example"},{"name":"Test Studio B","url":"https://b.example"}]. ' +
      'Do it immediately, do not explain how, just call the tool.';
    document.querySelector('#send').click();
    return true;
  })()`, true);

  const t0 = Date.now();
  let last = 0;
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
      log('reply:', s.text);
      break;
    }
    if (Date.now() - last > 15000) { last = Date.now(); log('  still running, ' + Math.round((Date.now() - t0) / 1000) + 's elapsed'); }
    if (Date.now() - t0 > 240000) { log('TIMED OUT after 4 minutes'); break; }
  }

  // Ground truth: check every place this file could plausibly have landed.
  const candidates = [
    'D:\\Hanzla-GPT\\Exports\\diagnostic-test.csv',
    path.join(os.homedir(), 'Downloads', 'diagnostic-test.csv'),
    path.join(process.env.HGPT_USER_DATA, 'exports', 'diagnostic-test.csv'),
  ];
  log('--- checking every possible save location ---');
  let found = null;
  for (const c of candidates) {
    const exists = fs.existsSync(c);
    log((exists ? 'FOUND ' : 'absent') + '  ' + c);
    if (exists) found = c;
  }

  if (found) {
    log('FILE CONTENTS:');
    log(fs.readFileSync(found, 'utf8'));
    log('RESULT: the tool DID run and the file is at: ' + found);
  } else {
    log('RESULT: the file does not exist ANYWHERE checked — the model did not actually call the tool, regardless of what its reply said.');
  }

  app.exit(0);
});
