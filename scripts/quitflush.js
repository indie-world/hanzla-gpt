'use strict';
/* Adds a chat WITHOUT saving, then quits normally. The file is inspected by the
   caller after the process is gone, so the quit flush is verified from outside. */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');
if (!process.env.HGPT_USER_DATA) {
  process.env.HGPT_USER_DATA = path.join(os.tmpdir(), 'hanzla-gpt-quit');
}
require('../src/main.js');

app.whenReady().then(async () => {
  const win = await new Promise((res) => {
    const t = () => { const w = BrowserWindow.getAllWindows()[0]; w ? res(w) : setTimeout(t, 200); };
    t();
  });
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  await new Promise((r) => setTimeout(r, 2000));

  await win.webContents.executeJavaScript(`(() => {
    conversations.length = 0;
    conversations.push({
      id: 'unsaved', title: 'Never explicitly saved', model: 'llama3.2:3b',
      createdAt: new Date().toISOString(), status: 'done',
      messages: [{ id: 'm', role: 'user', content: 'this must survive a normal quit' }],
    });
    return true;    // no save call at all — the quit handler must catch it
  })()`, true);

  console.log('[quit] seeded without saving; quitting now');
  app.quit();
});
