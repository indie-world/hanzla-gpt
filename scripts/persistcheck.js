'use strict';
/* Proves chat history survives, and that nothing can blank a populated file. */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const PROFILE = path.join(os.tmpdir(), 'hanzla-gpt-persist');
if (!process.env.HGPT_USER_DATA) process.env.HGPT_USER_DATA = PROFILE;
require('../src/main.js');

const log = (...a) => console.log('[persist]', ...a);
let fails = 0;
const check = (ok, label, detail) => {
  log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '  — ' + detail : ''));
  if (!ok) fails++;
};

const convFile = () => path.join(PROFILE, 'conversations.json');
const readConv = () => {
  try { return JSON.parse(fs.readFileSync(convFile(), 'utf8')); } catch { return null; }
};

app.whenReady().then(async () => {
  const win = await new Promise((res) => {
    const t = () => { const w = BrowserWindow.getAllWindows()[0]; w ? res(w) : setTimeout(t, 200); };
    t();
  });
  win.webContents.on('console-message', (_e, l, m) => { if (l >= 2) log('CONSOLE', m); });
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  await new Promise((r) => setTimeout(r, 2000));

  // seed three conversations with content and force them to disk
  await win.webContents.executeJavaScript(`(async () => {
    conversations.length = 0;
    for (let i = 1; i <= 3; i++) {
      conversations.push({
        id: 'seed' + i, title: 'Seeded chat ' + i, model: 'llama3.2:3b',
        createdAt: new Date().toISOString(), status: 'done',
        messages: [
          { id: 'u' + i, role: 'user', content: 'question ' + i },
          { id: 'a' + i, role: 'assistant', content: 'answer ' + i, model: 'llama3.2:3b' },
        ],
      });
    }
    currentId = 'seed1';
    await flushSave();
    return true;
  })()`, true);
  await new Promise((r) => setTimeout(r, 600));

  let disk = readConv();
  check(Array.isArray(disk) && disk.length === 3, 'three chats written to disk', (disk || []).length + '');
  check(disk && disk[0].messages.length === 2, 'messages persisted with content');

  // the load guard: a save fired before loading must not wipe anything
  await win.webContents.executeJavaScript(`(async () => {
    stateLoaded = false;          // simulate a save racing the initial load
    conversations.length = 0;
    saveSoon();
    await new Promise(r => setTimeout(r, 900));
    stateLoaded = true;
    return true;
  })()`, true);
  disk = readConv();
  check(disk && disk.length === 3, 'save before load did NOT wipe history', (disk || []).length + ' chats');

  // the write guard: even a direct empty write must be refused
  await win.webContents.executeJavaScript(
    "window.api.storeSet('conversations.json', [])", true);
  await new Promise((r) => setTimeout(r, 700));
  disk = readConv();
  check(disk && disk.length === 3, 'empty write refused against populated file', (disk || []).length + ' chats');

  // Restore the in-memory list from disk, exactly as a restart would.
  await win.webContents.executeJavaScript('loadState()', true);
  const reloaded = await win.webContents.executeJavaScript('conversations.length', true);
  check(reloaded === 3, 'history reloads from disk after the scare', reloaded + ' chats');

  // a genuine deletion of one chat must still work
  const delInfo = await win.webContents.executeJavaScript(`(async () => {
    const before = conversations.length;
    conversations = conversations.filter(c => c.id !== 'seed2');
    const afterMem = conversations.length;
    const snap = snapshot();
    await flushSave();
    return { before, afterMem, snapLen: snap.length, stateLoaded };
  })()`, true);
  log('delete diagnostics:', JSON.stringify(delInfo));
  await new Promise((r) => setTimeout(r, 1200));
  disk = readConv();
  check(disk && disk.length === 2, 'real deletion still applies', (disk || []).length + ' chats');
  check(disk && !disk.some((c) => c.id === 'seed2'), 'the right chat was removed');

  const backup = path.join(PROFILE, 'conversations.backup.json');
  check(fs.existsSync(backup), 'a rolling backup exists', backup);

  // finally: quit through the real path and confirm unsaved work is flushed
  await win.webContents.executeJavaScript(`(() => {
    conversations.push({
      id: 'lastminute', title: 'Typed just before quit', model: 'llama3.2:3b',
      createdAt: new Date().toISOString(), status: 'done',
      messages: [{ id: 'x', role: 'user', content: 'this must survive the quit' }],
    });
    return true;   // deliberately NOT saved — the quit flush has to catch it
  })()`, true);

  log('quitting through the normal path …');
  setTimeout(() => {
    const after = readConv();
    const survived = Array.isArray(after) && after.some((c) => c.id === 'lastminute');
    log((survived ? 'PASS  ' : 'FAIL  ') + 'unsaved chat flushed on quit');
    log(survived && fails === 0 ? 'ALL PERSISTENCE CHECKS PASSED' : (fails + (survived ? 0 : 1)) + ' FAILED');
    process.exit(survived && fails === 0 ? 0 : 1);
  }, 3500);

  app.quit();   // triggers before-quit -> flush -> real exit
});
