'use strict';

/*
 * Server side of the browser link. A small Chrome extension (see /extension)
 * connects here over a plain WebSocket from whichever Chrome window the user
 * installed it into — any profile, already open, nothing closed or spawned.
 *
 * This replaces the earlier CDP-based approach: Chrome 136+ silently refuses
 * to open a remote-debugging port on its default profile directory, which
 * made "attach to the browser the user already has open" impossible over CDP.
 * Standard extension APIs (tabs, scripting) have no such restriction.
 */

const { WebSocketServer } = require('ws');

const PORT = Number(process.env.HGPT_EXT_PORT || 8765);

let wss = null;
let client = null;   // the most recently linked extension; simplest useful policy
const pending = new Map();   // request id -> { resolve, reject, timer }
let nextId = 1;

function start() {
  if (wss) return;
  wss = new WebSocketServer({ host: '127.0.0.1', port: PORT });

  wss.on('connection', (ws) => {
    client = ws;
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'hello') return;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg);
      else p.reject(new Error(msg.error || 'Browser link returned an error'));
    });
    ws.on('close', () => { if (client === ws) client = null; });
    ws.on('error', () => { try { ws.close(); } catch { /* ignore */ } });
  });

  wss.on('error', (err) => {
    console.error('extension bridge server error:', err.message);
  });
}

function isLinked() {
  return !!client && client.readyState === client.OPEN;
}

function send(type, extra, timeoutMs = 20000) {
  if (!isLinked()) {
    return Promise.reject(new Error('NOT_LINKED'));
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('The linked browser did not respond in time.'));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    client.send(JSON.stringify({ id, type, ...extra }));
  });
}

async function status() {
  return { connected: isLinked() };
}

async function listTabs() {
  const r = await send('list_tabs', {});
  return r.tabs || [];
}

async function readTab(tabId) {
  const r = await send('read_tab', { tabId });
  return r.page;
}

async function openAndRead(url) {
  const r = await send('open_url', { url }, 30000);
  return r.page;
}

async function click(query) {
  const r = await send('click', { query });
  return { action: r.action, page: r.page };
}

async function type(fieldHint, text, submit) {
  const r = await send('type', { fieldHint, text, submit: !!submit });
  return { action: r.action, page: r.page };
}

async function extractLinks(filter) {
  const r = await send('extract_links', { filter });
  return r.action;   // { count, links }
}

async function scroll(amount) {
  const r = await send('scroll', { amount });
  return { action: r.action, page: r.page };
}

async function collectPages(url, maxPages, nextButtonText, filter) {
  // Generous per-page allowance: page load + click + settle can be slow on
  // sites with heavy client-side rendering, and this loop runs unattended.
  const timeoutMs = 20000 + Math.max(1, maxPages) * 20000;
  const r = await send('collect_pages', { url, maxPages, nextButtonText, filter }, timeoutMs);
  return r.result;   // { pages, stopReason, count, links }
}

async function captureVoyagerPosts(url, settleMs) {
  const r = await send('voyager_posts', { url, settleMs }, 60000);
  return r.result;
}

async function shadowInspect(url) {
  const r = await send('shadow_inspect', { url }, 50000);
  return r.result;
}

async function inspectTimestamp(url) {
  const r = await send('inspect_timestamp', { url }, 40000);
  return r.result;
}

async function clickTimestampTest(url) {
  const r = await send('click_timestamp_test', { url }, 40000);
  return r.result;
}

async function debugPosts(url) {
  const r = await send('debug_posts', { url }, 40000);
  return r.result;
}

async function linkedinPosts(url, scrolls) {
  // scrolling a feed is slow: allow generous time per scroll pass
  const timeoutMs = 60000 + (scrolls || 6) * 8000;
  const r = await send('linkedin_posts', { url, scrolls }, timeoutMs);
  return r.result;   // { count, posts: [{urn, url, text}] }
}

async function pageFull(url, settleMs) {
  const r = await send('page_full', { url, settleMs }, 60000);
  return r.result;   // { title, url, text, links, emails }
}

async function enrichCompany(linkedinUrl, companyName) {
  // LinkedIn about + website + contact page + possible Google fallback:
  // up to four page loads with settle time each.
  const r = await send('enrich_company', { linkedinUrl, companyName }, 120000);
  return r.result;
}

async function writeSheetCell(tabId, cell, value) {
  const r = await send('sheet_write_cell', { tabId, cell, value }, 30000);
  return r.result;   // { ok }
}

async function pressSheetKey(tabId, key) {
  const r = await send('sheet_key', { tabId, key }, 20000);
  return r.result;   // { ok, pressed }
}

async function writeSheetRows(tabId, startCell, rowsValues) {
  const cellCount = (rowsValues || []).reduce((n, r) => n + r.filter((v) => v !== null && v !== undefined && String(v) !== '').length, 0);
  const timeoutMs = 20000 + cellCount * 4000;
  const r = await send('sheet_write_rows', { tabId, startCell, rowsValues }, timeoutMs);
  return r.result;   // { ok, written: [rowNumbers] }
}

async function deleteSheetRow(tabId, row) {
  const r = await send('sheet_delete_row', { tabId, row }, 25000);
  return r.result;   // { ok, row }
}

async function pasteSheet(tabId, cell) {
  const r = await send('sheet_paste', { tabId, cell }, 60000);
  return r.result;   // { ok, pastedAt }
}

async function deleteSheetRows(tabId, rows) {
  const timeoutMs = 20000 + (rows ? rows.length : 0) * 3000;
  const r = await send('sheet_delete_rows', { tabId, rows }, timeoutMs);
  return r.result;   // { ok, deleted: [...] }
}

async function writeSheetRow(tabId, startCell, values) {
  // ~1.5s per cell of trusted-input round trips, plus attach overhead.
  const timeoutMs = 15000 + (values ? values.length : 0) * 4000;
  const r = await send('sheet_write_row', { tabId, startCell, values }, timeoutMs);
  return r.result;   // { ok, written }
}

async function readSheetCell(tabId, cell) {
  const r = await send('sheet_read_cell', { tabId, cell });
  return r.result;   // { ok, text, formulaBarFound }
}

module.exports = {
  start, status, listTabs, readTab, openAndRead, isLinked, PORT,
  click, type, extractLinks, scroll, collectPages, writeSheetCell, readSheetCell, writeSheetRow, writeSheetRows, pressSheetKey, deleteSheetRow, deleteSheetRows, pasteSheet,
  enrichCompany, pageFull, linkedinPosts, debugPosts, clickTimestampTest, inspectTimestamp, shadowInspect, captureVoyagerPosts,
};
