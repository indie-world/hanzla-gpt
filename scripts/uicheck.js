'use strict';
/* Visual + functional check of the sidebar features: rename, status dots,
   model trait labels, private mode. Runs on an isolated profile. */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

if (!process.env.HGPT_USER_DATA) {
  process.env.HGPT_USER_DATA = path.join(os.tmpdir(), 'hanzla-gpt-uicheck');
}
require('../src/main.js');

const log = (...a) => console.log('[ui]', ...a);
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
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  await new Promise((r) => setTimeout(r, 3000));

  // Model picker labels
  const opts = await win.webContents.executeJavaScript(
    '[...document.querySelectorAll("#model-select option")].map(o => o.textContent)', true);
  log('model picker:');
  opts.forEach((o) => log('   ' + o));
  check(opts.some((o) => /\(.*fast/i.test(o)), 'picker labels models as fast');
  check(opts.some((o) => /\(.*smart/i.test(o)), 'picker labels models as smart');
  check(opts.every((o) => /\(.+\)/.test(o)), 'every model carries a label');

  // Build three chats with different statuses, then rename one
  const r = await win.webContents.executeJavaScript(`(() => {
    conversations.length = 0;
    conversations.push(
      { id: 'a', title: 'Finished thread',  messages: [], status: 'done',       model: '' },
      { id: 'b', title: 'Replying now',     messages: [], status: 'generating', model: '' },
      { id: 'c', title: 'Failed thread',    messages: [], status: 'error',      model: '' },
      { id: 'd', title: 'Secret',           messages: [], status: 'idle', private: true, model: '' },
    );
    currentId = 'a';
    renderChatList();
    return {
      dots: [...document.querySelectorAll('#chat-list .st')].map(d => d.className),
      badges: document.querySelectorAll('#chat-list .lock').length,
    };
  })()`, true);
  check(r.dots.includes('st st-done'), 'done status dot rendered');
  check(r.dots.includes('st st-generating'), 'generating status dot rendered');
  check(r.dots.includes('st st-error'), 'error status dot rendered');
  check(r.badges === 1, 'private badge rendered', r.badges + '');

  // Rename via the same path F2 / double-click uses
  const rn = await win.webContents.executeJavaScript(`(() => {
    beginRename('a');
    const inp = document.querySelector('.rename-input');
    if (!inp) return { opened: false };
    inp.value = 'Renamed by test';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const chat = conversations.find(c => c.id === 'a');
    return { opened: true, title: chat.title, locked: !!chat.titleLocked };
  })()`, true);
  check(rn.opened, 'rename editor opens');
  check(rn.title === 'Renamed by test', 'rename saved', rn.title);
  check(rn.locked, 'renamed title is protected from auto-naming');

  // Private mode chrome
  const pv = await win.webContents.executeJavaScript(`(() => {
    document.querySelector('#toggle-private').click();
    return {
      banner: !document.querySelector('#private-banner').classList.contains('hidden'),
      themed: document.body.classList.contains('private-mode'),
    };
  })()`, true);
  check(pv.banner && pv.themed, 'private mode chrome active');

  await win.webContents.executeJavaScript(
    "document.querySelector('#toggle-private').click(); renderChatList();", true);
  await new Promise((r) => setTimeout(r, 400));

  const img = await win.webContents.capturePage();
  const out = path.join(__dirname, 'uicheck-shot.png');
  fs.writeFileSync(out, img.toPNG());
  log('screenshot ->', out);

  log(fails === 0 ? 'ALL UI CHECKS PASSED' : fails + ' FAILED');
  app.exit(fails === 0 ? 0 : 1);
});
