'use strict';

/*
 * Talks to the Hanzla-GPT desktop app over a plain WebSocket to localhost.
 * No native messaging host, no debugging port — just standard extension APIs
 * (tabs, scripting) reached through a socket the app already has open. That is
 * what lets this attach to whichever Chrome window the user already has open,
 * on whichever profile they installed the extension into.
 */

const PORT = 8765;
const URL = 'ws://127.0.0.1:' + PORT;

let socket = null;
let connecting = false;

function log(...args) {
  console.log('[Hanzla-GPT]', ...args);
}

function connect() {
  if (connecting || (socket && socket.readyState === WebSocket.OPEN)) return;
  connecting = true;

  try {
    socket = new WebSocket(URL);
  } catch (err) {
    connecting = false;
    return;
  }

  socket.addEventListener('open', () => {
    connecting = false;
    log('linked to Hanzla-GPT');
    socket.send(JSON.stringify({ type: 'hello', extVersion: '1.0.0' }));
    chrome.action.setBadgeText({ text: '' });
  });

  socket.addEventListener('message', async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    const reply = (payload) => socket.send(JSON.stringify({ id: msg.id, ...payload }));

    try {
      if (msg.type === 'list_tabs') {
        const tabs = await chrome.tabs.query({});
        reply({ ok: true, tabs: tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active })) });
      } else if (msg.type === 'read_tab') {
        const page = await readTab(msg.tabId);
        reply({ ok: true, page });
      } else if (msg.type === 'open_url') {
        const page = await openAndRead(msg.url);
        reply({ ok: true, page });
      } else if (msg.type === 'click') {
        const result = await runInTab(CLICK_FN, [msg.query]);
        reply(result);
      } else if (msg.type === 'type') {
        const result = await runInTab(TYPE_FN, [msg.fieldHint, msg.text, !!msg.submit]);
        reply(result);
      } else if (msg.type === 'extract_links') {
        const result = await runInTab(EXTRACT_LINKS_FN, [msg.filter || '']);
        reply(result);
      } else if (msg.type === 'scroll') {
        const result = await runInTab(SCROLL_FN, [msg.amount || 'down']);
        reply(result);
      } else if (msg.type === 'collect_pages') {
        const result = await collectPages(msg.url, msg.maxPages || 3, msg.nextButtonText || 'Next', msg.filter || '');
        reply({ ok: true, result });
      } else if (msg.type === 'voyager_posts') {
        const result = await collectPostsForQuery(msg.url);
        reply({ ok: true, result });
      } else if (msg.type === 'shadow_inspect') {
        const result = await shadowInspect(msg.url);
        reply({ ok: true, result });
      } else if (msg.type === 'inspect_timestamp') {
        const result = await inspectTimestamp(msg.url);
        reply({ ok: true, result });
      } else if (msg.type === 'click_timestamp_test') {
        const result = await clickTimestampTest(msg.url);
        reply({ ok: true, result });
      } else if (msg.type === 'debug_posts') {
        const result = await debugPostsPage(msg.url);
        reply({ ok: true, result });
      } else if (msg.type === 'linkedin_posts') {
        const result = await collectLinkedInPosts(msg.url, msg.scrolls || 6);
        reply({ ok: true, result });
      } else if (msg.type === 'page_full') {
        const result = await openPageFull(msg.url, msg.settleMs);
        reply({ ok: true, result });
      } else if (msg.type === 'enrich_company') {
        const result = await enrichCompany(msg.linkedinUrl, msg.companyName || '');
        reply({ ok: true, result });
      } else if (msg.type === 'sheet_write_cell') {
        const result = await sheetWriteTrusted(msg.tabId, msg.cell, msg.value);
        reply({ ok: true, result });
      } else if (msg.type === 'sheet_write_row') {
        const result = await sheetWriteRowTrusted(msg.tabId, msg.startCell, msg.values);
        reply({ ok: true, result });
      } else if (msg.type === 'sheet_write_rows') {
        // Whole batch under ONE debugger attach — each attach raises the
        // Chrome window (the debug banner), so per-row attaches made every
        // write burst steal focus repeatedly. One attach per batch instead.
        const m = /^([A-Za-z]+)(\d+)$/.exec(String(msg.startCell || '').trim());
        if (!m) { reply({ ok: false, error: 'bad startCell' }); return; }
        const colToNum = (s) => s.toUpperCase().split('').reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
        const numToCol = (n) => { let s = ''; while (n > 0) { s = String.fromCharCode(65 + ((n - 1) % 26)) + s; n = Math.floor((n - 1) / 26); } return s; };
        const startCol = colToNum(m[1]);
        let row = Number(m[2]);
        await ensureInWorkerWindow(msg.tabId);
        const written = [];
        await withFocusedWorker(msg.tabId, async () => {
        await chrome.debugger.attach({ tabId: msg.tabId }, '1.3');
        try {
          for (const values of (msg.rowsValues || [])) {
            for (let i = 0; i < values.length; i++) {
              const v = values[i];
              if (v === null || v === undefined || String(v) === '') continue;
              await writeCellViaCdp(msg.tabId, numToCol(startCol + i) + row, v);
            }
            written.push(row);
            row++;
          }
        } finally {
          try { await chrome.debugger.detach({ tabId: msg.tabId }); } catch { /* gone */ }
        }
        });
        reply({ ok: true, result: { ok: true, written } });
      } else if (msg.type === 'sheet_paste') {
        // One trusted Ctrl+V of TSV already on the system clipboard. Sheets
        // parses tabs/newlines into cells itself, so a whole batch lands in a
        // single operation — no per-cell editor dance, which is where the
        // keystroke writer kept failing silently.
        await ensureInWorkerWindow(msg.tabId);
        await withFocusedWorker(msg.tabId, async () => {
          await chrome.debugger.attach({ tabId: msg.tabId }, '1.3');
          try {
            await trustedKey(msg.tabId, 'Escape', 'Escape', 27);
            await new Promise((r) => setTimeout(r, 200));
            await chrome.scripting.executeScript({
              target: { tabId: msg.tabId }, func: SELECT_CELL_FN, args: [msg.cell],
            });
            await new Promise((r) => setTimeout(r, 600));
            await trustedKey(msg.tabId, 'v', 'KeyV', 86, null, 2);   // Ctrl+V
            await new Promise((r) => setTimeout(r, 3500));
          } finally {
            try { await chrome.debugger.detach({ tabId: msg.tabId }); } catch { /* gone */ }
          }
        });
        reply({ ok: true, result: { ok: true, pastedAt: msg.cell } });
      } else if (msg.type === 'sheet_delete_row') {
        const result = await sheetDeleteRowTrusted(msg.tabId, msg.row);
        reply({ ok: true, result });
      } else if (msg.type === 'sheet_delete_rows') {
        // Many rows under one debugger attach (focus is raised per attach).
        // Caller must send rows sorted descending so indices stay valid.
        const rowsDesc = (msg.rows || []).slice().sort((a, b) => b - a);
        await ensureInWorkerWindow(msg.tabId);
        const deleted = [];
        await withFocusedWorker(msg.tabId, async () => {
        await chrome.debugger.attach({ tabId: msg.tabId }, '1.3');
        try {
          for (const row of rowsDesc) {
            await trustedKey(msg.tabId, 'Escape', 'Escape', 27);
            await new Promise((r) => setTimeout(r, 150));
            await chrome.scripting.executeScript({
              target: { tabId: msg.tabId }, func: SELECT_CELL_FN, args: [row + ':' + row],
            });
            await new Promise((r) => setTimeout(r, 400));
            await trustedKey(msg.tabId, '-', 'Minus', 189, null, 3);
            await new Promise((r) => setTimeout(r, 450));
            deleted.push(row);
          }
        } finally {
          try { await chrome.debugger.detach({ tabId: msg.tabId }); } catch { /* gone */ }
        }
        });
        reply({ ok: true, result: { ok: true, deleted } });
      } else if (msg.type === 'sheet_key') {
        // Recovery hatch: a single trusted keystroke (Escape to close a stuck
        // editor, Delete to clear the selected cell).
        const KEYS = { Escape: [27, null], Delete: [46, null], Enter: [13, '\r'] };
        const spec = KEYS[msg.key];
        if (!spec) { reply({ ok: false, error: 'unsupported key: ' + msg.key }); return; }
        await ensureInWorkerWindow(msg.tabId);
        await chrome.debugger.attach({ tabId: msg.tabId }, '1.3');
        try {
          await trustedKey(msg.tabId, msg.key, msg.key, spec[0], spec[1]);
        } finally {
          try { await chrome.debugger.detach({ tabId: msg.tabId }); } catch { /* already gone */ }
        }
        reply({ ok: true, result: { ok: true, pressed: msg.key } });
      } else if (msg.type === 'sheet_read_cell') {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: msg.tabId }, func: READ_SHEET_CELL_FN, args: [msg.cell],
        });
        reply({ ok: true, result });
      } else {
        reply({ ok: false, error: 'Unknown command: ' + msg.type });
      }
    } catch (err) {
      reply({ ok: false, error: String((err && err.message) || err) });
    }
  });

  socket.addEventListener('close', () => {
    connecting = false;
    socket = null;
    log('disconnected, will retry');
  });
  socket.addEventListener('error', () => {
    try { socket.close(); } catch { /* ignore */ }
  });
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error('No open tab found.');
  return tab;
}

const EXTRACT = () => {
  const pick = document.querySelector('article, main, [role="main"]') || document.body;
  const text = (pick.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
  return { title: document.title, url: location.href, text: text.slice(0, 20000) };
};

async function readTab(tabId) {
  const tab = tabId ? await chrome.tabs.get(tabId) : await activeTab();
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: EXTRACT,
  });
  return { ...result, tabId: tab.id };
}

/* Runs one of the interaction functions below in the active tab and returns
   its {ok, ...} result, followed by a fresh read of the page so the model can
   see what changed without a second round trip. */
async function runInTab(func, args) {
  const tab = await activeTab();
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func, args });
  await new Promise((r) => setTimeout(r, 500));   // let the click/type settle before reading
  const page = await readTab(tab.id);
  return { ok: true, action: result, page };
}

/* All four run inside the page, so they only see the DOM — no access to the
   extension APIs above this line. Matching is heuristic (visible text, common
   attributes) because the model describes elements in plain language, not by
   CSS selector, and generated selectors are unreliable across real sites. */

function CLICK_FN(query) {
  const q = String(query || '').trim().toLowerCase();
  const candidates = Array.from(document.querySelectorAll(
    'a, button, [role="button"], input[type="submit"], input[type="button"], label, [role="checkbox"], [role="option"], [role="tab"]'
  ));
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  };
  const textOf = (el) => (
    el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || ''
  ).trim().toLowerCase();

  let best = null;
  for (const el of candidates) {
    if (!visible(el)) continue;
    const t = textOf(el);
    if (!t) continue;
    if (t === q) { best = el; break; }
    if (!best && t.includes(q)) best = el;
  }
  if (!best) return { clicked: false, reason: 'No visible element matched "' + query + '".' };
  best.scrollIntoView({ block: 'center' });
  best.click();
  return { clicked: true, text: textOf(best).slice(0, 80) };
}

function TYPE_FN(fieldHint, text, submit) {
  const hint = String(fieldHint || '').trim().toLowerCase();
  const fields = Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"]'));
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const labelOf = (el) => (
    el.placeholder || el.getAttribute('aria-label') || el.name || el.id || ''
  ).toLowerCase();

  let field = fields.find((el) => visible(el) && labelOf(el).includes(hint));
  if (!field && !hint) field = fields.find(visible);
  if (!field) return { typed: false, reason: 'No visible input matched "' + fieldHint + '".' };

  field.scrollIntoView({ block: 'center' });
  field.focus();
  if (field.isContentEditable) {
    field.textContent = text;
    field.dispatchEvent(new InputEvent('input', { bubbles: true }));
  } else {
    // The native setter is required so frameworks like React see the change.
    const proto = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (submit) {
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    const form = field.closest('form');
    if (form && form.requestSubmit) form.requestSubmit();
  }
  return { typed: true, into: labelOf(field).slice(0, 60) };
}

function EXTRACT_LINKS_FN(filter) {
  const f = String(filter || '').trim().toLowerCase();
  const seen = new Set();
  const out = [];
  for (const a of document.querySelectorAll('a[href]')) {
    const text = (a.innerText || a.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ');
    const href = a.href;
    if (!text || !href || href.startsWith('javascript:')) continue;
    if (f && !text.toLowerCase().includes(f) && !href.toLowerCase().includes(f)) continue;
    const key = href + '|' + text;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text: text.slice(0, 140), href });
    if (out.length >= 150) break;
  }
  return { count: out.length, links: out };
}

function SCROLL_FN(amount) {
  if (amount === 'bottom') window.scrollTo(0, document.body.scrollHeight);
  else if (amount === 'top') window.scrollTo(0, 0);
  else window.scrollBy(0, window.innerHeight * 0.85);
  return { scrolledTo: amount };
}

/* Google Sheets renders the grid itself as a single canvas — there is no
   per-cell DOM to click or type into. The Name Box (a real <input>) and the
   formula bar (a real contenteditable that always mirrors the selected
   cell's value) are the only genuine DOM handles into cell content, so both
   functions below drive the sheet through those two elements only. Every
   write is immediately followed by a read-back of the same cell so the
   caller can verify the value actually landed instead of assuming it did. */
/* Sheets ignores synthetic (isTrusted:false) keyboard input for cell
   editing, so committing a value needs the debugger API: keystrokes sent
   through CDP's Input domain are trusted, same as DevTools. Selecting the
   target cell still goes through the Name Box (which does accept scripted
   navigation, proven by the read path), then trusted keys type and commit. */
function cdp(tabId, method, params) {
  return chrome.debugger.sendCommand({ tabId }, method, params || {});
}

/* `text` matters: Enter only commits an open Sheets editor when the keyDown
   carries its character payload ('\r'), like a physical keypress does. A
   rawKeyDown without text is ignored by the editor — observed directly: the
   edit session stayed open and every later insertText appended to it.
   CDP modifier bits: Alt=1, Ctrl=2, Meta=4, Shift=8. */
async function trustedKey(tabId, key, code, keyCode, text, modifiers) {
  const down = { type: text ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
  if (text) { down.text = text; down.unmodifiedText = text; }
  if (modifiers) down.modifiers = modifiers;
  await cdp(tabId, 'Input.dispatchKeyEvent', down);
  await cdp(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
    ...(modifiers ? { modifiers } : {}),
  });
}

/* Deletes one whole sheet row: select A<row>, Shift+Space grows the selection
   to the full row, Ctrl+Alt+Minus removes it. Caller must delete bottom-up
   when removing several rows so the remaining indices stay valid. */
async function sheetDeleteRowTrusted(tabId, row) {
  await ensureInWorkerWindow(tabId);
  await chrome.debugger.attach({ tabId }, '1.3');
  try {
    await trustedKey(tabId, 'Escape', 'Escape', 27);
    await new Promise((r) => setTimeout(r, 200));
    // "548:548" in the Name Box selects the entire row — no keystroke tricks
    // needed for selection (synthetic Shift+Space was silently ignored).
    await chrome.scripting.executeScript({
      target: { tabId }, func: SELECT_CELL_FN, args: [row + ':' + row],
    });
    await new Promise((r) => setTimeout(r, 450));
    await trustedKey(tabId, '-', 'Minus', 189, null, 3);         // Ctrl+Alt+Minus: delete selected row
    await new Promise((r) => setTimeout(r, 550));
    return { ok: true, row };
  } finally {
    try { await chrome.debugger.detach({ tabId }); } catch { /* already gone */ }
  }
}

/* Values never contain newlines (callers strip them), so insertText is one
   shot; Enter commits the cell and Escape after is unnecessary. */
async function writeCellViaCdp(tabId, cellRef, value) {
  // Escape first: closes any editor left open by an earlier failed attempt,
  // otherwise the Name Box navigation below is silently ignored.
  await trustedKey(tabId, 'Escape', 'Escape', 27);
  await new Promise((r) => setTimeout(r, 200));
  // Select the cell through the Name Box (scripted part, works untrusted).
  await chrome.scripting.executeScript({
    target: { tabId }, func: SELECT_CELL_FN, args: [cellRef],
  });
  await new Promise((r) => setTimeout(r, 400));
  // Both keys are required, in this order:
  //   Delete — clears existing content, so the write replaces rather than
  //            appends (F2 alone put the caret after the old text, which
  //            produced "ValueValue" on any rewrite).
  //   F2     — opens the (now empty) cell editor. insertText only lands in
  //            an active editor; with Delete alone every write was a silent
  //            no-op that still reported success.
  await trustedKey(tabId, 'Delete', 'Delete', 46);
  await new Promise((r) => setTimeout(r, 150));
  await trustedKey(tabId, 'F2', 'F2', 113);
  await new Promise((r) => setTimeout(r, 200));
  await cdp(tabId, 'Input.insertText', { text: String(value).replace(/[\r\n]+/g, ' ') });
  await new Promise((r) => setTimeout(r, 150));
  await trustedKey(tabId, 'Enter', 'Enter', 13, '\r');
  await new Promise((r) => setTimeout(r, 250));
}

async function sheetWriteTrusted(tabId, cellRef, value) {
  await ensureInWorkerWindow(tabId);
  return withFocusedWorker(tabId, async () => {
    await chrome.debugger.attach({ tabId }, '1.3');
    try {
      await writeCellViaCdp(tabId, cellRef, value);
      return { ok: true };
    } finally {
      try { await chrome.debugger.detach({ tabId }); } catch { /* already gone */ }
    }
  });
}

/* Writes a whole row in one debugger attach/detach cycle: values go into
   startCell's row, one column after another (blank entries are skipped, so
   Kimi's layout with its empty G column maps naturally). */
async function sheetWriteRowTrusted(tabId, startCell, values) {
  const m = /^([A-Za-z]+)(\d+)$/.exec(String(startCell || '').trim());
  if (!m) return { ok: false, error: 'bad startCell: ' + startCell };
  const colToNum = (s) => s.toUpperCase().split('').reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
  const numToCol = (n) => { let s = ''; while (n > 0) { s = String.fromCharCode(65 + ((n - 1) % 26)) + s; n = Math.floor((n - 1) / 26); } return s; };
  const startCol = colToNum(m[1]);
  const row = m[2];

  await ensureInWorkerWindow(tabId);
  await chrome.debugger.attach({ tabId }, '1.3');
  const written = [];
  try {
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v === null || v === undefined || String(v) === '') continue;
      const cell = numToCol(startCol + i) + row;
      await writeCellViaCdp(tabId, cell, v);
      written.push(cell);
    }
    return { ok: true, written };
  } finally {
    try { await chrome.debugger.detach({ tabId }); } catch { /* already gone */ }
  }
}

function SELECT_CELL_FN(cellRef) {
  const nameBox = document.querySelector('input#t-name-box') || document.querySelector('[aria-label="Name box" i]');
  if (!nameBox) return { ok: false, error: 'name box not found' };
  const setNative = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  nameBox.focus();
  setNative.call(nameBox, cellRef);
  nameBox.dispatchEvent(new Event('input', { bubbles: true }));
  nameBox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
  return { ok: true };
}

async function READ_SHEET_CELL_FN(cellRef) {
  const nameBox = document.querySelector('input#t-name-box') || document.querySelector('[aria-label="Name box" i]');
  if (!nameBox) return { ok: false, error: 'name box not found' };
  const setNative = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  nameBox.focus();
  setNative.call(nameBox, cellRef);
  nameBox.dispatchEvent(new Event('input', { bubbles: true }));
  nameBox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
  await new Promise((r) => setTimeout(r, 400));

  const visible = (el) => el.getBoundingClientRect().width > 0;
  const editables = Array.from(document.querySelectorAll('[contenteditable="true"]')).filter(visible);
  const target = editables.find((el) => /formula|cell-input/i.test(el.id + ' ' + el.className)) || editables[0] || null;
  return { ok: true, text: target ? target.textContent : null, formulaBarFound: !!target };
}

function waitForLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const done = () => { chrome.tabs.onUpdated.removeListener(listener); resolve(); };
    const timer = setTimeout(done, timeoutMs);
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') { clearTimeout(timer); done(); }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/* Only bare domains ("example.com") get https:// prepended. A URL that
   already names a scheme — including file:// for opening a locally saved
   export — is left exactly as given. */
function normalizeUrl(url) {
  const u = String(url || '').trim();
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(u)) return u;
  return 'https://' + u.replace(/^\/+/, '');
}

async function openAndRead(url) {
  url = normalizeUrl(url);
  // opens in the dedicated minimized worker window — never the user's own
  const tab = await workerTab(url);
  await waitForLoad(tab.id);
  await new Promise((r) => setTimeout(r, 700)); // let client-rendered pages settle
  return readTab(tab.id);
}

/* Runs the entire "open, extract, click Next, extract again" loop inside the
 * extension itself, deterministically, instead of asking the model to chain
 * many individual tool calls turn by turn. Small local models were observed
 * to be unreliable at that kind of long multi-step orchestration — this makes
 * pagination a single, dependable tool call instead.
 *
 * Many sites (including LinkedIn) update search results via in-page requests
 * rather than a full navigation when "Next" is clicked, so tabs.onUpdated
 * never fires 'complete' for that click. waitForLoad's own timeout floor
 * covers that case: it always resolves, just later, after which the DOM has
 * already updated.
 */
async function collectPages(url, maxPages, nextText, filter) {
  url = normalizeUrl(url);
  const tab = await workerTab(url);
  await waitForLoad(tab.id);
  await new Promise((r) => setTimeout(r, 900));

  const seen = new Set();
  const all = [];
  let pages = 0;
  let stopReason = 'reached max_pages';

  try {
  for (let i = 0; i < maxPages; i++) {
    pages++;
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, func: EXTRACT_LINKS_FN, args: [filter],
    });
    for (const l of (result.links || [])) {
      const key = l.href + '|' + l.text;
      if (!seen.has(key)) { seen.add(key); all.push(l); }
    }

    if (i === maxPages - 1) break;

    const [{ result: clickResult }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, func: CLICK_FN, args: [nextText],
    });
    if (!clickResult.clicked) { stopReason = 'no "' + nextText + '" button found (reached the end)'; break; }

    await new Promise((r) => setTimeout(r, 600));
    await waitForLoad(tab.id, 10000);
    await new Promise((r) => setTimeout(r, 900));
  }

  return { pages, stopReason, count: all.length, links: all };
  } finally {
    try { await chrome.tabs.remove(tab.id); } catch { /* already closed */ }
  }
}

/* Deterministic company-enrichment pipeline: LinkedIn about page → company
 * website (incl. its contact page) → Google search fallback. All scripted —
 * no model in the loop — because pattern-matching emails/phones and following
 * a fixed sequence of pages is mechanical work small local models were
 * observed to do unreliably. Tabs open in the background (active: false) so
 * the user's browsing is not hijacked while a batch runs. */

const CONTACT_PATTERNS_FN = () => {
  const text = (document.body.innerText || '').slice(0, 60000);
  const emails = new Set();
  const phones = new Set();

  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
    const e = m[0].toLowerCase();
    if (!/\.(png|jpg|jpeg|gif|svg|webp|css|js)$/.test(e)) emails.add(e);
  }
  for (const a of document.querySelectorAll('a[href^="mailto:"]')) {
    const e = a.getAttribute('href').replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase();
    if (e) emails.add(e);
  }
  for (const a of document.querySelectorAll('a[href^="tel:"]')) {
    const p = a.getAttribute('href').replace(/^tel:/i, '').trim();
    if (p.replace(/\D/g, '').length >= 7) phones.add(p);
  }
  for (const m of text.matchAll(/\+\d[\d\s().-]{7,18}\d/g)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 8 && digits.length <= 15) phones.add(m[0].replace(/\s+/g, ' ').trim());
  }

  const contactLinks = [];
  for (const a of document.querySelectorAll('a[href]')) {
    const t = ((a.innerText || '') + ' ' + a.href).toLowerCase();
    if (/contact|get in touch|reach us|about-us|aboutus/.test(t) && a.href.startsWith('http')) {
      contactLinks.push(a.href);
      if (contactLinks.length >= 3) break;
    }
  }

  return {
    emails: Array.from(emails).slice(0, 10),
    phones: Array.from(phones).slice(0, 10),
    contactLinks,
    text: text.slice(0, 4000),
  };
};

const LINKEDIN_ABOUT_FN = () => {
  const text = (document.body.innerText || '').slice(0, 40000);
  const grab = (label) => {
    const re = new RegExp(label + '\\s*\\n\\s*([^\\n]+)', 'i');
    const m = text.match(re);
    return m ? m[1].trim() : '';
  };
  let website = grab('Website');
  if (!/^https?:\/\//i.test(website)) {
    // Fall back to the first external, non-LinkedIn link in the overview.
    for (const a of document.querySelectorAll('a[href^="http"]')) {
      const h = a.href;
      if (!/linkedin\.com|licdn\.com/i.test(h)) { website = h; break; }
    }
  }
  return {
    website,
    industry: grab('Industry'),
    companySize: grab('Company size'),
    headquarters: grab('Headquarters'),
    type: grab('Type'),
    founded: grab('Founded'),
    specialties: grab('Specialties'),
    followers: (text.match(/([\d,.]+[KM]?)\s+followers/i) || [])[1] || '',
    phoneOnPage: (text.match(/Phone\s*\n\s*([^\n]+)/i) || [])[1] || '',
  };
};

/* All pipeline tabs open inside one dedicated minimized window, so page
   loads can never raise or focus the window the user is actually using —
   whatever the underlying focus path was, it cannot reach a minimized
   window that is never focused. The window is created on first use and
   reused; if the user closes it, the next call recreates it. */
/* The worker-window id MUST live in chrome.storage.session, not a module
   variable: an MV3 service worker is torn down after ~30s idle, which resets
   module state. With the id only in memory every restart created a BRAND NEW
   worker window, and a long run left dozens of stray Chrome windows piled up
   in the taskbar. Session storage survives worker restarts (and is cleared
   when the browser closes, which is exactly the lifetime we want). */
const WORKER_KEY = 'hgptWorkerWindowId';
/* Marker URL identifying a window this extension created. Adoption and
   cleanup match on this and nothing else, so the user's own windows can
   never be mistaken for ours. */
const WORKER_MARKER = 'about:blank#hgpt-worker';

/* Serialises window creation. Enrichment runs many requests in parallel, so
   without this every concurrent caller found "no worker window yet" at the
   same instant and each created its own — which is how a run ended up with a
   dozen stray windows. One creation at a time; everyone else waits and gets
   the same window. */
/* Minimising a window makes Windows hand focus to whatever is behind it, so
   calling this unconditionally on every tab creation made the user's Chrome
   windows visibly shuffle. Only act when the window is not already
   minimised. */
async function ensureMinimized(windowId) {
  try {
    const w = await chrome.windows.get(windowId);
    if (w.state !== 'minimized') await chrome.windows.update(windowId, { state: 'minimized' });
  } catch { /* window gone; nothing to do */ }
}

let workerLock = Promise.resolve();
function withWorkerLock(fn) {
  const run = workerLock.then(fn, fn);
  workerLock = run.then(() => undefined, () => undefined);
  return run;
}

/* Closes any extra worker windows (single tab, still on about:blank) that a
   previous race or an old build left behind, so the pileup self-heals. */
async function closeStrayWorkers(keepId) {
  try {
    const wins = await chrome.windows.getAll({ populate: true });
    for (const w of wins) {
      if (w.id === keepId) continue;
      const tabs = w.tabs || [];
      // Marker-only match: a plain about:blank window is very likely one the
      // USER just opened, and closing it would destroy their window.
      if (tabs.length === 1 && [tabs[0].url, tabs[0].pendingUrl].some((u) => (u || '').startsWith(WORKER_MARKER))) {
        try { await chrome.windows.remove(w.id); } catch { /* already gone */ }
      }
    }
  } catch { /* best effort */ }
}

/* The worker-window id lives in chrome.storage.session, not a module
   variable: an MV3 service worker is torn down after ~30s idle, which resets
   module state, and the id would be lost on every restart.

   `seedUrl` matters too: a window must be created with at least one tab, and
   creating it on about:blank left a pointless blank page in the taskbar.
   Seeding the window with the page we were about to load avoids that. */
function getWorkerWindow(seedUrl) {
  return withWorkerLock(async () => {
    let stored = null;
    try { stored = (await chrome.storage.session.get(WORKER_KEY))[WORKER_KEY]; } catch { /* fall through */ }
    if (stored != null) {
      try {
        await chrome.windows.get(stored);
        await ensureMinimized(stored);
        return { id: stored, seedTabId: null };
      } catch { /* window was closed; make a new one below */ }
    }

    // Adopt a stray worker window rather than adding to the pile — but ONLY
    // one carrying our marker URL. The previous test ("a window with a single
    // about:blank tab") also describes the user's own freshly-opened window,
    // so it would adopt THEIR window, minimize it, and load scraping tabs into
    // it. Never touch a window this extension did not create.
    try {
      const wins = await chrome.windows.getAll({ populate: true });
      const orphan = wins.find((w) => (w.tabs || []).length === 1
        && [w.tabs[0].url, w.tabs[0].pendingUrl].some((u) => (u || '').startsWith(WORKER_MARKER)));
      if (orphan) {
        await chrome.storage.session.set({ [WORKER_KEY]: orphan.id });
        await ensureMinimized(orphan.id);
        await closeStrayWorkers(orphan.id);
        return { id: orphan.id, seedTabId: orphan.tabs[0].id };
      }
    } catch { /* fall through to create */ }

    const w = await chrome.windows.create({ url: seedUrl || WORKER_MARKER, focused: false, type: 'normal' });
    // Chrome ignores `state:'minimized'` passed to create(), so minimize after.
    try { await chrome.windows.update(w.id, { state: 'minimized' }); } catch { /* best effort */ }
    try { await chrome.storage.session.set({ [WORKER_KEY]: w.id }); } catch { /* best effort */ }
    await closeStrayWorkers(w.id);
    return { id: w.id, seedTabId: (w.tabs && w.tabs[0] && w.tabs[0].id) || null };
  });
}

/* Opens `url` inside the (minimized) worker window and returns its tab.
   When the window has to be created, the URL seeds it directly so no blank
   tab is ever produced. */
let seedConsumed = false;
async function workerTab(url) {
  const w = await getWorkerWindow(url);
  if (w.seedTabId != null && !seedConsumed) {
    seedConsumed = true;
    try {
      await chrome.tabs.update(w.seedTabId, { url });
      return { id: w.seedTabId };
    } catch { /* seed tab vanished; fall through */ }
  }
  const tab = await chrome.tabs.create({ url, active: false, windowId: w.id });
  await ensureMinimized(w.id);
  return tab;
}

async function openInBackground(url, settleMs) {
  const tab = await workerTab(url);
  await waitForLoad(tab.id, 20000);
  await new Promise((r) => setTimeout(r, settleMs));
  return tab;
}

/* chrome.debugger.attach force-activates the debugged tab (to show its
   banner), which yanked the user to the sheet tab on every write burst.
   Moving the tab into the minimized worker window first makes that forced
   activation invisible — it activates inside a window that is never shown. */
async function ensureInWorkerWindow(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const workerId = (await getWorkerWindow()).id;
  if (tab.windowId !== workerId) {
    await chrome.tabs.move(tabId, { windowId: workerId, index: -1 });
    await new Promise((r) => setTimeout(r, 400));
  }
}

/* Chrome only delivers trusted keyboard input (CDP Input domain) to a
   FOCUSED window — in a background window every keystroke is silently
   dropped, which is why writes and pastes reported success while changing
   nothing. So a keyboard burst must focus the worker window for its
   duration, then hand focus straight back to the window the user was in.
   One brief flicker per batch instead of one per cell. */
async function withFocusedWorker(tabId, fn) {
  let previous = null;
  try { previous = (await chrome.windows.getLastFocused()).id; } catch { /* none */ }
  const workerId = (await getWorkerWindow()).id;
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(workerId, { focused: true });
  await new Promise((r) => setTimeout(r, 350));
  try {
    return await fn();
  } finally {
    if (previous !== null && previous !== workerId) {
      try { await chrome.windows.update(previous, { focused: true }); } catch { /* window gone */ }
    }
  }
}

async function runFn(tabId, func, args = []) {
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return result;
}

async function closeQuiet(tabId) {
  try { await chrome.tabs.remove(tabId); } catch { /* already closed */ }
}


/* Scrapes a LinkedIn content-search results page: scrolls to pull in more
 * results, then reads each post's text plus its activity URN, which is what
 * a permalink is built from (https://www.linkedin.com/feed/update/<urn>/).
 * Runs in the minimized worker window like everything else. */


/* LinkedIn's feed-post internals live inside CLOSED shadow roots, which are
 * architecturally unreachable from any injected script (element.shadowRoot
 * returns null for everyone but the code that created it). The real data
 * those components render FROM is fetched/embedded as JSON before shadow
 * DOM enters the picture — LinkedIn actually server-renders the initial
 * search results directly into the main document's HTML response for
 * hydration, so capturing THAT response (not a follow-up XHR) is what
 * reveals real activity URNs. Uses the `debugger` permission already
 * granted for Sheets writes; no new manifest permissions needed.
 */
async function captureVoyagerUrns(url, settleMs) {
  const windowId = (await getWorkerWindow()).id;
  // Blank first, THEN attach + enable Network, THEN navigate — creating the
  // tab already pointed at the target URL starts requests firing before
  // Network.enable can take effect, and those responses are gone by the
  // time the listener is attached.
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false, windowId });
  const bodies = [];
  let attached = false;
  try {
    await chrome.debugger.attach({ tabId: tab.id }, '1.3');
    attached = true;
    const seenRequests = new Map();   // requestId -> url
    const onEvent = (source, method, params) => {
      if (source.tabId !== tab.id) return;
      if (method === 'Network.responseReceived') {
        const u = params.response.url || '';
        const mime = (params.response.mimeType || '');
        if (/voyager|graphql/i.test(u) || /html|json/i.test(mime)) seenRequests.set(params.requestId, u);
      }
      if (method === 'Network.loadingFinished' && seenRequests.has(params.requestId)) {
        bodies.push({ requestId: params.requestId, url: seenRequests.get(params.requestId) });
      }
    };
    chrome.debugger.onEvent.addListener(onEvent);
    await chrome.debugger.sendCommand({ tabId: tab.id }, 'Network.enable', {});
    await chrome.tabs.update(tab.id, { url: normalizeUrl(url) });
    await waitForLoad(tab.id, 25000);
    await new Promise((r) => setTimeout(r, settleMs || 6000));
    // trigger lazy-loaded results, twice
    for (let i = 0; i < 2; i++) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => window.scrollTo(0, document.body.scrollHeight) });
      await new Promise((r) => setTimeout(r, 2500));
    }
    await new Promise((r) => setTimeout(r, 1500));
    chrome.debugger.onEvent.removeListener(onEvent);

    const urns = [];
    const seenUrn = new Set();
    for (const b of bodies) {
      let body;
      try {
        body = await chrome.debugger.sendCommand({ tabId: tab.id }, 'Network.getResponseBody', { requestId: b.requestId });
      } catch { continue; }
      const text = body && body.body ? (body.base64Encoded ? atob(body.body) : body.body) : '';
      const matches = text.match(/urn:li:activity:\d+/g) || [];
      for (const m of matches) {   // order preserved — matches visual top-to-bottom order
        if (seenUrn.has(m)) continue;
        seenUrn.add(m);
        urns.push(m);
      }
    }
    // The rendered text (via innerText) correctly includes closed-shadow-DOM
    // content — the browser flattens it for layout/rendering regardless of
    // JS access restrictions — so this is where author/time/text come from.
    const [{ result: bodyText }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, func: () => document.body.innerText,
    });
    return { urns, bodyText };
  } finally {
    if (attached) { try { await chrome.debugger.detach({ tabId: tab.id }); } catch { /* gone */ } }
    try { await chrome.tabs.remove(tab.id); } catch { /* already closed */ }
  }
}

/* Splits the rendered page text into per-post blocks on the repeating "Feed
 * post" marker, then pulls author/time/text out of each with tolerant
 * pattern matching (fixed line positions vary between personal posts,
 * company-page posts, and reposts). Studio/agency-seeking posts are flagged
 * via keyword heuristic so a human can triage individual-hire vs
 * partnership posts at a glance. */
function parseFeedBlocks(bodyText) {
  const chunks = String(bodyText || '').split(/\n(?=Feed post\b)/).filter((c) => c.trim().startsWith('Feed post'));
  const STUDIO_RE = /\b(game (dev(elopment)?|art|audio) studio|development studio|outsourc\w*|co-?dev\w*|studio partner|external (team|studio)|partner (studio|agency)|agency partner|development (partner|vendor)|looking for a (studio|team|agency|vendor)|hiring an agency|studio to (partner|collaborat)|work with a studio)\b/i;
  return chunks.map((chunk) => {
    const lines = chunk.split('\n').map((l) => l.trim()).filter(Boolean);
    const timeMatch = chunk.match(/\b(\d+)\s*([hdwmo])\b\s*•/i) || chunk.match(/\b(\d+)([hdwmo])\b/i);
    const time = timeMatch ? timeMatch[1] + timeMatch[2] : '';
    const followIdx = lines.findIndex((l) => l === 'Follow' || l === 'Following' || l === '+ Follow');
    const author = lines[1] || '';
    const bodyLines = followIdx >= 0 ? lines.slice(followIdx + 1) : lines.slice(Math.min(5, lines.length));
    const text = bodyLines.join(' ').slice(0, 3000);
    return { author, time, text, isStudioSeeking: STUDIO_RE.test(chunk) };
  });
}

async function collectPostsForQuery(url) {
  const { urns, bodyText } = await captureVoyagerUrns(url);
  const blocks = parseFeedBlocks(bodyText);
  const n = Math.min(urns.length, blocks.length);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      urn: urns[i],
      permalink: 'https://www.linkedin.com/feed/update/' + urns[i] + '/',
      author: blocks[i].author,
      time: blocks[i].time,
      text: blocks[i].text,
      isStudioSeeking: blocks[i].isStudioSeeking,
    });
  }
  return { matchedCount: n, urnCount: urns.length, blockCount: blocks.length, posts: out };
}


/* One-shot page fetch for research scraping: opens a URL in the minimized
 * worker window, waits for it to settle, and returns the rendered text plus
 * every link and any e-mail addresses found (mailto: hrefs and plain text
 * matches). Deterministic — no model involved — so callers can scrape many
 * pages quickly and cheaply. */
const PAGE_FULL_FN = () => {
  const pick = document.querySelector('article, main, [role="main"]') || document.body;
  const text = (pick.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
  const links = [];
  const seen = new Set();
  const emails = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.href;
    const label = (a.innerText || a.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ');
    if (/^mailto:/i.test(href)) {
      const addr = href.replace(/^mailto:/i, '').split('?')[0].trim();
      if (addr) emails.add(addr.toLowerCase());
      continue;
    }
    if (!href || /^javascript:/i.test(href)) continue;
    const key = href + '|' + label;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ text: label.slice(0, 120), href });
    if (links.length >= 400) break;
  }
  const whole = (document.body.innerText || '');
  const re = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  let m;
  while ((m = re.exec(whole)) !== null) emails.add(m[0].toLowerCase());
  return { title: document.title, url: location.href, text: text.slice(0, 30000), links, emails: [...emails].slice(0, 40) };
};

async function openPageFull(url, settleMs) {
  const windowId = (await getWorkerWindow()).id;
  const tab = await chrome.tabs.create({ url: normalizeUrl(url), active: false, windowId });
  try {
    await waitForLoad(tab.id, 30000);
    await new Promise((r) => setTimeout(r, settleMs || 2200));
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: PAGE_FULL_FN });
    return result;
  } finally {
    try { await chrome.tabs.remove(tab.id); } catch { /* already closed */ }
  }
}

async function enrichCompany(linkedinUrl, companyName) {
  const out = {
    company: companyName, linkedinUrl,
    website: '', industry: '', companySize: '', headquarters: '', type: '',
    founded: '', specialties: '', followers: '',
    emails: [], phones: [], sources: [],
  };

  // 1. LinkedIn about page. The Overview panel (Website/Industry/Company
  // size/Headquarters) renders a moment after the header does, so a race
  // under concurrent load can catch the page before those labels exist —
  // confirmed directly: a page read straight after this same settle time
  // showed the header only, while a moment later the full Overview was
  // present. One retry with a longer wait (rather than a longer fixed delay
  // for every call) keeps the common case fast.
  const aboutUrl = normalizeUrl(linkedinUrl).replace(/\/+$/, '') .replace(/\/about$/, '') + '/about/';
  let tab = await openInBackground(aboutUrl, 2500);
  try {
    let li = await runFn(tab.id, LINKEDIN_ABOUT_FN);
    if (!li.industry && !li.companySize && !li.headquarters) {
      await new Promise((r) => setTimeout(r, 3500));
      li = await runFn(tab.id, LINKEDIN_ABOUT_FN);
    }
    Object.assign(out, {
      website: li.website || '', industry: li.industry, companySize: li.companySize,
      headquarters: li.headquarters, type: li.type, founded: li.founded,
      specialties: li.specialties, followers: li.followers,
    });
    if (li.phoneOnPage) { out.phones.push(li.phoneOnPage); out.sources.push('phone: LinkedIn'); }
  } finally { await closeQuiet(tab.id); }

  // 2. Company website + one contact page
  if (out.website) {
    try {
      tab = await openInBackground(out.website, 2000);
      let site;
      try { site = await runFn(tab.id, CONTACT_PATTERNS_FN); } finally { await closeQuiet(tab.id); }
      out.emails.push(...site.emails);
      out.phones.push(...site.phones);
      if (site.emails.length || site.phones.length) out.sources.push('site: homepage');

      if (!site.emails.length && site.contactLinks.length) {
        tab = await openInBackground(site.contactLinks[0], 2000);
        let contact;
        try { contact = await runFn(tab.id, CONTACT_PATTERNS_FN); } finally { await closeQuiet(tab.id); }
        out.emails.push(...contact.emails);
        out.phones.push(...contact.phones);
        if (contact.emails.length || contact.phones.length) out.sources.push('site: contact page');
      }
    } catch (err) {
      out.sources.push('site error: ' + String(err && err.message || err).slice(0, 80));
    }
  }

  // 3. Google fallback when both are still missing
  if (!out.emails.length && !out.phones.length && companyName) {
    try {
      const q = encodeURIComponent(companyName + ' game studio contact email phone');
      tab = await openInBackground('https://www.google.com/search?q=' + q, 2000);
      let g;
      try { g = await runFn(tab.id, CONTACT_PATTERNS_FN); } finally { await closeQuiet(tab.id); }
      out.emails.push(...g.emails.filter((e) => !/google|gstatic|example/.test(e)));
      out.phones.push(...g.phones);
      if (out.emails.length || out.phones.length) out.sources.push('google search');
    } catch { /* fallback is best-effort */ }
  }

  out.emails = Array.from(new Set(out.emails)).slice(0, 5);
  out.phones = Array.from(new Set(out.phones)).slice(0, 5);
  return out;
}

// MV3 service workers idle out; an alarm wakes this one periodically so the
// link survives even when the browser has been sitting idle.
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === '__status') {
    sendResponse({ connected: !!(socket && socket.readyState === WebSocket.OPEN) });
    return true;
  }
  if (msg && msg.type === '__reconnect') {
    connect();
    sendResponse({ ok: true });
    return true;
  }
});

connect();
