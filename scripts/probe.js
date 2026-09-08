'use strict';
/* Focused diagnostic: send one message and dump the in-memory message object. */

const { app, BrowserWindow } = require('electron');
require('../src/main.js');

const log = (...a) => console.log('[probe]', ...a);

app.whenReady().then(async () => {
  const win = await new Promise((res) => {
    const t = () => { const w = BrowserWindow.getAllWindows()[0]; w ? res(w) : setTimeout(t, 200); };
    t();
  });
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) log('CONSOLE', msg); });
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  await new Promise((r) => setTimeout(r, 2500));

  log('userData =', app.getPath('userData'));

  const before = await win.webContents.executeJavaScript(`({
    convs: conversations.length,
    msgs: conversations.map(c => c.messages.length),
    contentLens: conversations.flatMap(c => c.messages.map(m => (m.content||'').length)),
  })`, true);
  log('loaded state:', JSON.stringify(before));

  await win.webContents.executeJavaScript(`(() => {
    document.querySelector('#new-chat').click();
    const s = document.querySelector('#model-select');
    s.value = 'llama3.2:3b'; s.dispatchEvent(new Event('change'));
    document.querySelector('#input').value = 'Say the single word: banana';
    document.querySelector('#send').click();
    return true;
  })()`, true);

  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 700));
    const done = await win.webContents.executeJavaScript(
      '!document.querySelector("#send").classList.contains("hidden")', true);
    if (done) break;
  }

  const after = await win.webContents.executeJavaScript(`(() => {
    const c = conversations.find(x => x.id === currentId);
    return {
      msgCount: c.messages.length,
      msgs: c.messages.map(m => ({ role: m.role, len: (m.content||'').length, sample: (m.content||'').slice(0,60) })),
      streamTargets: streamTargets.size,
      domLens: [...document.querySelectorAll('.msg.assistant')].map(n => n.querySelector('.content') ? n.querySelector('.content').textContent.length : -1),
      renderCheck: window.api.renderMessage('hello **world**').html.length,
    };
  })()`, true);
  log('after send:', JSON.stringify(after, null, 1));

  app.exit(0);
});
