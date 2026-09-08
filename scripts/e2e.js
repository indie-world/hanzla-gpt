'use strict';
/*
 * End-to-end smoke test for Hanzla-GPT.
 *   npm run e2e                       (fast, llama3.2:3b)
 *   E2E_MODEL=qwen3:4b npm run e2e    (also exercises the reasoning panel)
 *
 * Boots the real app, drives a message through the UI, and checks that the
 * reply renders, code lands in the side panel, and stats come back.
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// Run against a throwaway profile so the real app can stay open and real chats
// are never touched.
const os = require('node:os');
if (!process.env.HGPT_USER_DATA) {
  process.env.HGPT_USER_DATA = require('node:path').join(os.tmpdir(), 'hanzla-gpt-e2e');
}

require('../src/main.js');

const MODEL = process.env.E2E_MODEL || 'llama3.2:3b';
const PROMPT = process.env.E2E_PROMPT ||
  'Write a Python function that reverses a string. Reply with one short sentence and one code block.';
const TIMEOUT_MS = parseInt(process.env.E2E_TIMEOUT || '600000', 10);

const log = (...a) => console.log('[e2e]', ...a);
let failures = 0;
const check = (ok, label, detail) => {
  log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '  — ' + detail : ''));
  if (!ok) failures++;
};

function waitForWindow() {
  return new Promise((resolve) => {
    const tick = () => {
      const w = BrowserWindow.getAllWindows()[0];
      if (w) resolve(w); else setTimeout(tick, 200);
    };
    tick();
  });
}

async function poll(win, expr, label, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    const v = await win.webContents.executeJavaScript(expr, true);
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error('timeout waiting for ' + label);
    await new Promise((r) => setTimeout(r, 400));
  }
}

app.whenReady().then(async () => {
  try {
    const win = await waitForWindow();
    win.webContents.on('console-message', (_e, level, message, line, src) => {
      if (level >= 2) log('CONSOLE[' + level + ']', message, '(' + String(src).split(/[\\/]/).pop() + ':' + line + ')');
    });
    if (win.webContents.isLoading()) {
      await new Promise((r) => win.webContents.once('did-finish-load', r));
    }

    check(win.getTitle() === 'Hanzla-GPT', 'window titled Hanzla-GPT', win.getTitle());

    // --- preload bridge -------------------------------------------------
    const keys = await poll(win, 'window.api ? Object.keys(window.api).length : 0', 'bridge', 15000);
    check(keys > 15, 'preload bridge exposed', keys + ' methods');

    // --- rendering ------------------------------------------------------
    const r = await win.webContents.executeJavaScript(
      'window.api.renderMessage("Hi **there**\\n\\n```python\\nprint(1)\\nprint(2)\\n```")', true);
    check(r.html.includes('<strong>'), 'markdown renders bold');
    check(r.html.includes('code-card'), 'fenced code becomes a card, not inline');
    check(!r.html.includes('print(1)'), 'code body is kept OUT of the chat html');
    check(r.blocks.length === 1 && r.blocks[0].lang === 'python', 'code block extracted', JSON.stringify(r.blocks[0] && r.blocks[0].lang));
    check(r.blocks[0] && r.blocks[0].lines === 2, 'line count correct', r.blocks[0] && String(r.blocks[0].lines));

    const hl = await win.webContents.executeJavaScript('window.api.highlightBlock("print(1)", "python")', true);
    check(hl.includes('hljs'), 'panel highlighting works');

    // --- XSS ------------------------------------------------------------
    const evil = await win.webContents.executeJavaScript(
      'window.api.renderMessage("<img src=x onerror=alert(1)>[x](javascript:alert(1))").html', true);
    check(!/onerror/i.test(evil), 'inline event handler stripped');
    check(!/javascript:/i.test(evil), 'javascript: URL stripped');

    // --- models ---------------------------------------------------------
    await poll(win, 'document.querySelectorAll("#model-select option").length', 'model list', 25000);
    const names = await win.webContents.executeJavaScript(
      '[...document.querySelectorAll("#model-select option")].map(o=>o.value)', true);
    check(names.includes(MODEL), 'model list includes ' + MODEL, names.join(', '));

    // --- send a real message -------------------------------------------
    log('sending prompt to ' + MODEL + ' (timeout ' + Math.round(TIMEOUT_MS / 1000) + 's) …');
    // Start a clean conversation so persisted history cannot skew the reply.
    await win.webContents.executeJavaScript("document.querySelector('#new-chat').click()", true);
    await new Promise((r) => setTimeout(r, 300));
    await win.webContents.executeJavaScript(`(() => {
      const s = document.querySelector('#model-select');
      s.value = ${JSON.stringify(MODEL)};
      s.dispatchEvent(new Event('change'));
      document.querySelector('#input').value = ${JSON.stringify(PROMPT)};
      document.querySelector('#send').click();
      return true;
    })()`, true);

    check(await poll(win, '!document.querySelector("#stop").classList.contains("hidden")', 'gen start', 60000),
      'generation started');

    const t0 = Date.now();
    let last = 0;
    for (;;) {
      const s = await win.webContents.executeJavaScript(`(() => {
        const n = [...document.querySelectorAll('.msg.assistant')].pop();
        return {
          done: !document.querySelector('#send').classList.contains('hidden'),
          chars: n && n.querySelector('.content') ? n.querySelector('.content').textContent.length : -1,
          think: n && n.querySelector('.think-body') ? n.querySelector('.think-body').textContent.length : -1,
        };
      })()`, true);
      if (s.done) break;
      if (Date.now() - t0 > TIMEOUT_MS) throw new Error('generation timed out (content=' + s.chars + ' think=' + s.think + ')');
      if (Date.now() - last > 15000) {
        last = Date.now();
        log('  … ' + Math.round((Date.now() - t0) / 1000) + 's  content=' + s.chars + ' reasoning=' + s.think);
      }
      await new Promise((r) => setTimeout(r, 600));
    }
    log('  generation finished in ' + Math.round((Date.now() - t0) / 1000) + 's');

    const res = await win.webContents.executeJavaScript(`(() => {
      const n = [...document.querySelectorAll('.msg.assistant')].pop();
      return {
        text: n.querySelector('.content') ? n.querySelector('.content').textContent : '',
        cards: n.querySelectorAll('.code-card').length,
        isError: n.classList.contains('error'),
        stats: n.querySelector('.stats') ? n.querySelector('.stats').textContent : '',
        thinking: n.querySelector('.think-body') ? n.querySelector('.think-body').textContent.length : 0,
        panelOpen: !document.querySelector('#code-panel').classList.contains('collapsed'),
        panelCode: document.querySelector('#cp-body').textContent.trim(),
        panelLang: document.querySelector('#cp-lang').textContent,
        tabs: document.querySelectorAll('.cp-tab').length,
      };
    })()`, true);

    if (res.text.trim().length === 0) {
      const dump = await win.webContents.executeJavaScript(`
        [...document.querySelectorAll('.msg.assistant')].map((n,i) => ({
          i,
          streaming: n.classList.contains('streaming'),
          err: n.classList.contains('error'),
          role: n.querySelector('.role') ? n.querySelector('.role').textContent : '',
          len: n.querySelector('.content') ? n.querySelector('.content').textContent.length : -1,
          cards: n.querySelectorAll('.code-card').length,
        }))`, true);
      log('DOM DUMP', JSON.stringify(dump));
    }
    check(!res.isError, 'reply returned without error', res.text.slice(0, 90));
    check(res.text.trim().length > 10, 'reply has prose', res.text.length + ' chars');
    check(!/<\/think>/i.test(res.text), 'no leaked </think> in the answer');
    check(/tok\/s/.test(res.stats), 'token stats shown', res.stats);
    check(res.cards >= 1, 'code appears as a card in chat', res.cards + ' card(s)');
    check(res.panelOpen, 'code panel opened automatically');
    check(res.panelCode.length > 10, 'panel shows the code', res.panelCode.slice(0, 60).replace(/\n/g, ' '));
    check(res.tabs >= 1, 'panel tab created', res.tabs + ' tab(s)');
    check(!res.text.includes(res.panelCode.slice(0, 25)), 'code is NOT duplicated in the chat column');

    if (MODEL.startsWith('qwen3')) {
      check(res.thinking > 0, 'reasoning captured in its own panel', res.thinking + ' chars');
    }

    const persisted = await win.webContents.executeJavaScript(
      'document.querySelectorAll("#chat-list .chat-item").length', true);
    check(persisted >= 1, 'conversation saved to sidebar', persisted + ' item(s)');

    // --- private mode ---------------------------------------------------
    const priv = await win.webContents.executeJavaScript(`(async () => {
      document.querySelector('#toggle-private').click();
      document.querySelector('#input').value = 'private test message';
      document.querySelector('#send').click();
      await new Promise(r => setTimeout(r, 900));
      return {
        banner: !document.querySelector('#private-banner').classList.contains('hidden'),
        bodyClass: document.body.classList.contains('private-mode'),
        badges: document.querySelectorAll('.chat-item .lock').length,
        exportDisabled: document.querySelector('#export-chat').disabled,
        inMemory: (await window.api.storeGet('conversations.json') || []).some(c => c.private === true),
        memoryHasText: JSON.stringify(await window.api.storeGet('conversations.json') || []).includes('private test message'),
      };
    })()`, true);
    check(priv.banner, 'private banner shown');
    check(priv.bodyClass, 'private theme applied');
    check(priv.badges >= 1, 'sidebar shows a private badge', priv.badges + ' badge(s)');
    check(priv.exportDisabled, 'export disabled while private');
    check(!priv.inMemory, 'private chat NOT written to conversations.json');
    check(!priv.memoryHasText, 'private message text never hits disk');

    await win.webContents.executeJavaScript(
      "document.querySelector('#stop').click(); document.querySelector('#toggle-private').click()", true);

    log('--- reply ---');
    log(res.text.slice(0, 400));
    log('--- panel (' + res.panelLang + ') ---');
    log(res.panelCode.slice(0, 400));

    const img = await win.webContents.capturePage();
    const out = path.join(__dirname, 'e2e-shot.png');
    fs.writeFileSync(out, img.toPNG());
    log('screenshot ->', out);
  } catch (err) {
    failures++;
    log('ERROR', err && err.stack ? err.stack : err);
  }

  log(failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED');
  app.exit(failures === 0 ? 0 : 1);
});
