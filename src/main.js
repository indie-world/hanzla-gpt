'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { spawn } = require('node:child_process');
const extBridge = require('./ext-bridge');
const updater = require('./updater');

const OLLAMA_HOST = process.env.OLLAMA_HOST_URL || 'http://127.0.0.1:11434';
const COMFY_HOST = process.env.COMFY_HOST_URL || 'http://127.0.0.1:8188';
const COMFY_ROOT = process.env.COMFY_ROOT || 'D:\\AI\\ComfyUI_windows_portable';

// Pin the identity so userData is the same folder no matter how the app is
// launched (packaged exe, `electron .`, or a script under scripts/).
const { protocol: _proto } = require('electron');
_proto.registerSchemesAsPrivileged([
  { scheme: 'hgptmedia', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false } },
]);

app.setName('Hanzla-GPT');
// Tests point this elsewhere so they never touch real chats, and so they can run
// while the installed app is open.
const ISOLATED = !!process.env.HGPT_USER_DATA;
app.setPath('userData', ISOLATED
  ? process.env.HGPT_USER_DATA
  : path.join(app.getPath('appData'), 'Hanzla-GPT'));

// Only ever one instance: a second launch focuses the window we already have.
const gotLock = ISOLATED ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  // exit(), not quit(): quit() is asynchronous, so app.whenReady() still fired
  // and this process built a second window before the quit took effect.
  app.exit(0);
} else if (!ISOLATED) {
  // Launching again just brings the existing window back, including from the tray.
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
      return;
    }
    if (!mainWindow.isVisible()) mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.setAlwaysOnTop(true);
    mainWindow.focus();
    mainWindow.setAlwaysOnTop(false);
  });
}

let mainWindow = null;
let tray = null;
let quitting = false;
const activeRequests = new Map(); // requestId -> AbortController

/* ------------------------------------------------------------------ */
/* Persistent store                                                     */
/* ------------------------------------------------------------------ */

const storeDir = () => app.getPath('userData');
const storePath = (name) => path.join(storeDir(), name);

async function readJson(name, fallback) {
  try {
    const raw = await fsp.readFile(storePath(name), 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

// Writes are serialised per file. Two overlapping saves used to share one fixed
// .tmp path, and on Windows the second rename would fail with EPERM — silently
// losing whatever that save contained.
const writeQueues = new Map();

function writeJson(name, value) {
  const prev = writeQueues.get(name) || Promise.resolve();
  const next = prev.then(() => writeJsonNow(name, value)).catch((err) => {
    console.error('store write failed for ' + name + ':', err.message);
    throw err;
  });
  // Keep the chain alive even if this link rejected.
  writeQueues.set(name, next.catch(() => {}));
  return next;
}

/* Conversations are the one thing that must never be lost, so a write that
   would empty a populated file is rejected outright, and the previous version
   is always kept alongside it. */
async function guardConversationWrite(name, value) {
  if (name !== 'conversations.json') return { ok: true };
  const target = storePath(name);
  let existing = null;
  try {
    existing = JSON.parse(await fsp.readFile(target, 'utf8'));
  } catch {
    return { ok: true };   // nothing to protect yet
  }
  if (!Array.isArray(existing) || !existing.length) return { ok: true };

  const incoming = Array.isArray(value) ? value : [];
  const existingWithContent = existing.filter((c) => c.messages && c.messages.length).length;
  const incomingWithContent = incoming.filter((c) => c.messages && c.messages.length).length;

  // A real deletion removes one or two chats; losing most of them at once is a bug.
  if (existingWithContent > 0 && incomingWithContent === 0) {
    return { ok: false, reason: 'refused to replace ' + existingWithContent + ' saved chats with none' };
  }
  try {
    await fsp.copyFile(target, storePath('conversations.backup.json'));
  } catch { /* backup is best effort */ }
  return { ok: true };
}

async function writeJsonNow(name, value) {
  const guard = await guardConversationWrite(name, value);
  if (!guard.ok) {
    console.error('store: ' + guard.reason);
    return;
  }

  await fsp.mkdir(storeDir(), { recursive: true });
  const tmp = storePath(name + '.' + process.pid + '.' + Date.now() + '.tmp');
  const body = JSON.stringify(value, null, 2);
  try {
    await fsp.writeFile(tmp, body, 'utf8');
    await fsp.rename(tmp, storePath(name));
  } catch (err) {
    // Windows can still refuse the rename if a scanner has the file open.
    // Falling back to a direct write is better than dropping the data.
    try { await fsp.unlink(tmp); } catch { /* ignore */ }
    if (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES') {
      await fsp.writeFile(storePath(name), body, 'utf8');
      return;
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Ollama server lifecycle                                              */
/* ------------------------------------------------------------------ */

function ollamaBinary() {
  const candidates = [
    path.join(app.getPath('home'), 'AppData', 'Local', 'Programs', 'Ollama', 'ollama.exe'),
    'C:\\Program Files\\Ollama\\ollama.exe',
    '/usr/local/bin/ollama',
    '/usr/bin/ollama',
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return 'ollama';
}

async function serverAlive(timeoutMs = 1500) {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(OLLAMA_HOST + '/api/version', { signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function ensureServer() {
  const alive = await serverAlive();
  if (alive) return { running: true, version: alive.version, started: false };

  try {
    const child = spawn(ollamaBinary(), ['serve'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch (err) {
    return { running: false, error: 'Could not launch Ollama: ' + err.message };
  }

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 700));
    const v = await serverAlive();
    if (v) return { running: true, version: v.version, started: true };
  }
  return { running: false, error: 'Ollama did not respond on ' + OLLAMA_HOST };
}

/* ------------------------------------------------------------------ */
/* Window                                                               */
/* ------------------------------------------------------------------ */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 840,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: '#131316',
    title: 'Hanzla-GPT',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // External links open in the real browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  // Closing the window hides it to the tray; a real quit comes from the tray
  // menu (or File > Quit), matching how Claude Desktop behaves.
  mainWindow.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function createTray() {
  const { Tray, nativeImage } = require('electron');
  const icoPath = path.join(__dirname, '..', 'build', 'icon.ico');
  let img = nativeImage.createFromPath(icoPath);
  if (img.isEmpty()) img = nativeImage.createEmpty();
  tray = new Tray(img);
  tray.setToolTip('Hanzla-GPT');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Hanzla-GPT', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { label: 'New chat', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.webContents.send('menu:new-chat'); } } },
    { type: 'separator' },
    { label: 'Check for updates…', click: () => updater.checkNow() },
    { type: 'separator' },
    { label: 'Quit Hanzla-GPT', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('double-click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
}

Menu.setApplicationMenu(
  Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        { label: 'New chat', accelerator: 'CmdOrCtrl+N', click: () => mainWindow && mainWindow.webContents.send('menu:new-chat') },
        { label: 'Rename chat', accelerator: 'F2', click: () => mainWindow && mainWindow.webContents.send('menu:rename-chat') },
        { type: 'separator' },
        { label: 'Close to tray', accelerator: 'CmdOrCtrl+W', click: () => mainWindow && mainWindow.hide() },
        { label: 'Quit Hanzla-GPT', accelerator: 'CmdOrCtrl+Q', click: () => { quitting = true; app.quit(); } },
      ],
    },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
  ])
);


// Saved clips are served over their own scheme; the page CSP allows media only
// from here, so nothing else on disk becomes reachable from the renderer.
function registerMediaProtocol() {
  const { protocol, net } = require('electron');
  protocol.handle('hgptmedia', async (req) => {
    const name = decodeURIComponent(new URL(req.url).pathname.replace(/^\//, ''));
    const file = path.join(videoDir(), path.basename(name));
    if (!fs.existsSync(file)) return new Response('not found', { status: 404 });
    return net.fetch('file:///' + file.replace(/\\/g, '/'));
  });
}

if (gotLock) {
  app.whenReady().then(() => {
  registerMediaProtocol();
  extBridge.start();
  startControlServer();
  createWindow();
  createTray();
  /* Auto-update from GitHub Releases. beforeInstall drains the renderer's
     pending chat writes, because quitAndInstall does not go through the
     before-quit flush below — the installer replaces the app underneath us. */
  updater.init({
    getParent: () => mainWindow,
    beforeInstall: () => new Promise((resolve) => {
      quitting = true;
      if (flushDone || !mainWindow || mainWindow.isDestroyed()) { flushDone = true; return resolve(); }
      const done = new Promise((res) => { flushResolve = res; });
      try { mainWindow.webContents.send('app:flush'); } catch { /* window already gone */ }
      Promise.race([done, new Promise((r) => setTimeout(r, 2000))]).then(() => {
        flushDone = true;   // lets before-quit skip its own flush and exit cleanly
        resolve();
      });
    }),
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else if (mainWindow) mainWindow.show();
  });
});
}

// The window living in the tray is not a reason to exit.
app.on('window-all-closed', () => { /* stay resident */ });

let flushDone = false;
let flushResolve = null;

ipcMain.handle('app:flushed', async () => {
  if (flushResolve) { flushResolve(); flushResolve = null; }
  return true;
});

/* The renderer batches saves, so give it a moment to write before we exit —
   otherwise the last few messages of a session are lost on quit. */
app.on('before-quit', (e) => {
  quitting = true;
  for (const ctl of activeRequests.values()) { try { ctl.abort(); } catch { /* ignore */ } }

  if (flushDone || !mainWindow || mainWindow.isDestroyed()) return;
  e.preventDefault();

  const done = new Promise((res) => { flushResolve = res; });
  try { mainWindow.webContents.send('app:flush'); } catch { /* window already gone */ }

  Promise.race([done, new Promise((r) => setTimeout(r, 2000))]).then(() => {
    flushDone = true;
    app.quit();
  });
});

/* ------------------------------------------------------------------ */
/* IPC: server + models                                                 */
/* ------------------------------------------------------------------ */

ipcMain.handle('ollama:ensure', async () => ensureServer());

ipcMain.handle('ollama:models', async () => {
  const res = await fetch(OLLAMA_HOST + '/api/tags');
  if (!res.ok) throw new Error('Failed to list models (HTTP ' + res.status + ')');
  const data = await res.json();
  return (data.models || [])
    .map((m) => ({
      name: m.name,
      size: m.size,
      family: (m.details && m.details.family) || '',
      parameterSize: (m.details && m.details.parameter_size) || '',
      quantization: (m.details && m.details.quantization_level) || '',
      modifiedAt: m.modified_at,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
});

ipcMain.handle('ollama:running', async () => {
  try {
    const res = await fetch(OLLAMA_HOST + '/api/ps');
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models || []).map((m) => ({
      name: m.name,
      sizeVram: m.size_vram || 0,
      size: m.size || 0,
    }));
  } catch {
    return [];
  }
});

ipcMain.handle('ollama:delete', async (_e, name) => {
  const res = await fetch(OLLAMA_HOST + '/api/delete', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: name }),
  });
  if (!res.ok) throw new Error('Delete failed (HTTP ' + res.status + ')');
  return true;
});

ipcMain.handle('ollama:pull', async (event, { name, requestId }) => {
  const ctl = new AbortController();
  activeRequests.set(requestId, ctl);
  try {
    const res = await fetch(OLLAMA_HOST + '/api/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name, stream: true }),
      signal: ctl.signal,
    });
    if (!res.ok || !res.body) throw new Error('Pull failed (HTTP ' + res.status + ')');

    for await (const obj of ndjson(res.body)) {
      if (obj.error) throw new Error(obj.error);
      event.sender.send('pull:progress', {
        requestId,
        status: obj.status || '',
        completed: obj.completed || 0,
        total: obj.total || 0,
      });
    }
    event.sender.send('pull:done', { requestId });
    return true;
  } catch (err) {
    if (err.name === 'AbortError') {
      event.sender.send('pull:done', { requestId, cancelled: true });
      return false;
    }
    event.sender.send('pull:done', { requestId, error: err.message });
    throw err;
  } finally {
    activeRequests.delete(requestId);
  }
});

/* ------------------------------------------------------------------ */
/* Browser tools the model can call                                     */
/* ------------------------------------------------------------------ */

const BROWSER_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'open_page',
      description: 'Open a web page in the user\'s connected Chrome browser and read its text. '
                 + 'Use this whenever the user asks to open, visit, browse, or look something up on a site.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The full URL, for example https://example.com' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_current_page',
      description: 'Read the text of the page currently open in the front tab of the browser.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_tabs',
      description: 'List the tabs currently open in the browser, with their titles and URLs.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'click_on',
      description: 'Click a button, link, checkbox, or filter on the current page. Describe it by '
                 + 'its visible text, e.g. "United States" or "Apply filters" — not a CSS selector. '
                 + 'Returns the page text after the click, so you can see what changed.',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'The visible text or label of the element to click.' },
        },
        required: ['description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'type_text',
      description: 'Type text into a visible input or search box on the current page, identified by '
                 + 'its placeholder or label. Optionally submit it (press Enter).',
      parameters: {
        type: 'object',
        properties: {
          field: { type: 'string', description: 'The placeholder or label of the field, e.g. "Search"' },
          text: { type: 'string', description: 'The text to type into it.' },
          submit: { type: 'boolean', description: 'Press Enter after typing. Defaults to false.' },
        },
        required: ['field', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'extract_links',
      description: 'Collect every link on the current page as {text, url} pairs — the reliable way '
                 + 'to pull a list of search results, company names, or profile links instead of '
                 + 'reading unstructured page text. Optionally filter by a keyword.',
      parameters: {
        type: 'object',
        properties: {
          filter: { type: 'string', description: 'Only keep links whose text or URL contains this (optional).' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scroll_page',
      description: 'Scroll the current page to load more results, e.g. on an infinite-scroll list. '
                 + 'Use "down" for one screen, "bottom" to jump to the end, "top" to return to the start.',
      parameters: {
        type: 'object',
        properties: { direction: { type: 'string', enum: ['down', 'bottom', 'top'] } },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_rows_to_file',
      description: 'Save a table of collected data (e.g. company names and links you gathered) to a '
                 + 'CSV file on the user\'s computer, so it can be imported into a spreadsheet. This '
                 + 'does NOT edit a Google Sheet directly — there is no live connection to one.',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'File name, e.g. "usa-game-studios.csv"' },
          rows: {
            type: 'array',
            description: 'Array of objects; each object\'s keys become the CSV columns.',
            items: { type: 'object' },
          },
        },
        required: ['filename', 'rows'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'collect_pages',
      description: 'Open a paginated list (like a LinkedIn or search results page), collect every '
                 + 'link, then click through to the next page and collect again, repeating up to '
                 + 'max_pages times. This does the ENTIRE loop in one call — you do NOT need to '
                 + 'call open_page, extract_links, and click_on yourself in sequence for a paginated '
                 + 'task; call this once instead. Optionally saves the combined results straight to '
                 + 'a CSV file, so a whole scraping task can be one tool call.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The first page to open, including any search filters.' },
          max_pages: { type: 'integer', description: 'How many pages to visit. Default 3, maximum 10.' },
          next_button_text: { type: 'string', description: 'Visible text of the "next page" control. Default "Next".' },
          link_filter: { type: 'string', description: 'Only keep links whose text or URL contains this (optional).' },
          save_as: { type: 'string', description: 'If given, save the results as a CSV with this filename.' },
        },
        required: ['url'],
      },
    },
  },
];

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function exportsDir() {
  for (const root of ['D:\\', 'E:\\', 'G:\\']) {
    try { if (fs.existsSync(root)) return path.join(root, 'Hanzla-GPT', 'Exports'); } catch { /* ignore */ }
  }
  return path.join(storeDir(), 'exports');
}

async function saveRowsToFile(filename, rows) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('No rows to save.');
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r || {})))];
  const lines = [cols.map(csvCell).join(',')];
  for (const r of rows) lines.push(cols.map((c) => csvCell(r[c])).join(','));

  const dir = exportsDir();
  await fsp.mkdir(dir, { recursive: true });
  const safe = String(filename || 'export.csv').replace(/[^\w.\- ]+/g, '').trim() || 'export.csv';
  const name = safe.toLowerCase().endsWith('.csv') ? safe : safe + '.csv';
  const full = path.join(dir, name);
  await fsp.writeFile(full, lines.join('\r\n'), 'utf8');
  return full;
}

function fileUrl(fullPath) {
  return 'file:///' + fullPath.replace(/\\/g, '/');
}

function joinSections(parts) {
  return parts.join('\n\n');
}

const TOOL_NAMES = BROWSER_TOOLS.map((t) => t.function.name);

/* Small local models are not reliably trained to use Ollama's structured
   tool_calls channel — qwen3:4b and llama3.2:3b were both observed, in the
   SAME conversation, sometimes emitting a real tool call and sometimes just
   printing tool-call-shaped JSON as plain text instead (confirmed by hitting
   /api/chat directly, so it is model behaviour, not a bug in this app's
   request). Rather than chase a "correct" model, this detects that pattern
   in the visible text and executes it anyway, tolerating malformed JSON. */
function extractInlineToolCall(text) {
  if (!text) return null;
  const nameRe = new RegExp('"name"\\s*:\\s*"(' + TOOL_NAMES.join('|') + ')"');
  const m = nameRe.exec(text);
  if (!m) return null;

  const toolName = m[1];
  let args = {};

  // Best effort: the surrounding object is often malformed (extra quotes,
  // a bare "{}" string instead of a real object), so a strict parse is only
  // one signal among several, not a requirement.
  const start = text.lastIndexOf('{', m.index);
  if (start !== -1) {
    let depth = 0, end = -1;
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end !== -1) {
      try {
        const obj = JSON.parse(text.slice(start, end + 1));
        if (obj && typeof obj === 'object') {
          Object.assign(args, obj.arguments || obj.parameters || obj.params || {});
        }
      } catch { /* fall through to the permissive scan below */ }
    }
  }

  // Permissive scan for the argument names this app's own tools use, in case
  // the strict parse above failed on malformed JSON.
  const FIELD_NAMES = ['url', 'description', 'field', 'text', 'filter', 'direction', 'filename'];
  for (const field of FIELD_NAMES) {
    if (args[field] !== undefined) continue;
    const fm = new RegExp('"' + field + '"\\s*:\\s*"([^"]*)"').exec(text);
    if (fm) args[field] = fm[1];
  }
  const submitM = /"submit"\s*:\s*(true|false)/.exec(text);
  if (submitM) args.submit = submitM[1] === 'true';

  return { name: toolName, arguments: args };
}

async function runBrowserTool(name, args) {
  if (name === 'save_rows_to_file') {
    try {
      const full = await saveRowsToFile(args.filename, args.rows);
      return joinSections([
        'Saved ' + (args.rows || []).length + ' rows to ' + full,
        'This is a local file, not a live edit to any Google Sheet \u2014 open Sheets and use File > Import to bring it in, or tell the user where the file is.',
        'To show it to the user in the linked browser, call open_page with url: ' + fileUrl(full),
      ]);
    } catch (err) {
      return 'Could not save the file: ' + err.message;
    }
  }

  if (!extBridge.isLinked()) {
    return 'NO BROWSER LINKED. Tell the user, in one short sentence, to open Settings -> '
         + 'Browser, load the Hanzla-GPT extension into any Chrome window (instructions are '
         + 'right there), and try again. Do not claim you are unable to browse in general \u2014 '
         + 'the capability exists, a browser is just not linked yet.';
  }
  try {
    if (name === 'open_page') {
      const page = await extBridge.openAndRead(String(args.url || ''));
      return joinSections([
        'Opened ' + page.url + '\nTitle: ' + page.title,
        '--- page text ---\n' + String(page.text || '').slice(0, 8000),
      ]);
    }
    if (name === 'read_current_page') {
      const page = await extBridge.readTab();
      return joinSections([
        'Current page: ' + page.url + '\nTitle: ' + page.title,
        '--- page text ---\n' + String(page.text || '').slice(0, 8000),
      ]);
    }
    if (name === 'list_tabs') {
      const tabs = await extBridge.listTabs();
      if (!tabs.length) return 'No tabs are open.';
      return tabs.map((t, i) => (i + 1) + '. ' + t.title + ' \u2014 ' + t.url).join('\n');
    }
    if (name === 'click_on') {
      const r = await extBridge.click(String(args.description || ''));
      if (!r.action.clicked) return 'Could not click: ' + r.action.reason;
      return joinSections([
        'Clicked "' + r.action.text + '".',
        '--- page text after clicking ---\n' + String(r.page.text || '').slice(0, 6000),
      ]);
    }
    if (name === 'type_text') {
      const r = await extBridge.type(String(args.field || ''), String(args.text || ''), !!args.submit);
      if (!r.action.typed) return 'Could not type: ' + r.action.reason;
      return joinSections([
        'Typed into "' + r.action.into + '".',
        '--- page text after typing ---\n' + String(r.page.text || '').slice(0, 6000),
      ]);
    }
    if (name === 'extract_links') {
      const r = await extBridge.extractLinks(String(args.filter || ''));
      if (!r.count) return 'No links found' + (args.filter ? ' matching "' + args.filter + '".' : '.');
      return (r.count + ' link(s):\n' + r.links.map((l) => '- ' + l.text + '  ' + l.href).join('\n')).slice(0, 8000);
    }
    if (name === 'scroll_page') {
      const r = await extBridge.scroll(String(args.direction || 'down'));
      return joinSections([
        'Scrolled.',
        '--- page text after scrolling ---\n' + String(r.page.text || '').slice(0, 6000),
      ]);
    }
    if (name === 'collect_pages') {
      const maxPages = Math.max(1, Math.min(10, parseInt(args.max_pages, 10) || 3));
      const r = await extBridge.collectPages(
        String(args.url || ''), maxPages, String(args.next_button_text || 'Next'), String(args.link_filter || '')
      );
      const parts = [
        'Visited ' + r.pages + ' page(s), stopped because: ' + r.stopReason + '.',
        'Collected ' + r.count + ' unique link(s).',
      ];
      if (args.save_as) {
        try {
          const full = await saveRowsToFile(args.save_as, r.links.map((l) => ({ name: l.text, url: l.href })));
          parts.push('Saved to ' + full + ' (local file — import it into Sheets via File > Import).');
          parts.push('To show it to the user in the linked browser, call open_page with url: ' + fileUrl(full));
        } catch (err) {
          parts.push('Could not save the file: ' + err.message);
        }
      } else {
        parts.push('Links:\n' + r.links.slice(0, 100).map((l) => '- ' + l.text + '  ' + l.href).join('\n'));
      }
      return joinSections(parts);
    }
  } catch (err) {
    return 'The browser tool failed: ' + err.message;
  }
  return 'Unknown tool: ' + name;
}

/* ------------------------------------------------------------------ */
/* IPC: streaming chat                                                  */
/* ------------------------------------------------------------------ */

async function* ndjson(stream) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) {
        try { yield JSON.parse(line); } catch { /* skip malformed line */ }
      }
    }
  }
  const tail = buffer.trim();
  if (tail) { try { yield JSON.parse(tail); } catch { /* ignore */ } }
}

/* ------------------------------------------------------------------ */
/* Headless control endpoint                                            */
/* ------------------------------------------------------------------ */

/* Deliberately a separate implementation from the chat:send IPC handler
 * below, rather than a shared refactor of it — chat:send is the path the
 * visible chat UI depends on and is already working; duplicating this
 * smaller subset of its logic is safer than risking a regression in it this
 * late. Keep the two in sync by hand if the tool loop changes.
 *
 * This never touches conversations.json or the renderer's chat state: no
 * visible window changes, no sidebar entry, nothing drawn on screen. It
 * exists so a command can be sent into the SAME running app — same linked
 * browser, same local Ollama — without any GUI automation.
 */
async function runHeadlessTurn(model, prompt, opts) {
  // Real cancellation: without this, a client that gave up (timeout, closed
  // terminal) left its Ollama generation running forever, and with
  // OLLAMA_NUM_PARALLEL=1 that single stuck request blocked every other
  // request on the whole server — including trivial, unrelated ones — until
  // Ollama itself was restarted. This is what actually happened, twice.
  const signal = (opts && opts.signal) || undefined;
  const baseOptions = {
    temperature: 0.7,
    top_p: 0.9,
    num_ctx: (opts && opts.numCtx) || 8192,
    // A second, independent safety net: even a client that stays connected
    // should never be able to make a single round run away unbounded.
    num_predict: (opts && opts.numPredict) || 1500,
  };

  const SYSTEM = 'You can control the user\'s Chrome browser through tools. To open or visit a '
    + 'website, call open_page with the URL. Use read_current_page to read what they are looking '
    + 'at, list_tabs to see what is open, and collect_pages for anything paginated (call it once '
    + 'with max_pages set instead of manually chaining open_page/click_on/extract_links yourself). '
    + 'Never say you are unable to browse — call the tool, and report whatever it returns.\n\n'
    + 'Never claim a page was opened, clicked, or a file was saved unless you actually called that '
    + 'tool IN THIS RESPONSE and are reporting its real result. Do not guess a file location such '
    + 'as "Downloads" — the tool result always states the exact path; quote it exactly.\n\n'
    + 'Once a tool result confirms the task is complete, STOP: give one short confirmation '
    + 'sentence and end your turn. Do not keep reasoning or calling more tools after it is done.';

  const convo = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: String(prompt) },
  ];

  const toolLog = [];
  let toolsUnsupported = false;

  for (let round = 0; round < 6; round++) {
    const body = { model, messages: convo, stream: true, options: baseOptions };
    if (!toolsUnsupported) body.tools = BROWSER_TOOLS;

    const res = await fetch(OLLAMA_HOST + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).error || ''; } catch { /* ignore */ }
      if (!toolsUnsupported && /tool/i.test(detail) && /support/i.test(detail)) { toolsUnsupported = true; continue; }
      throw new Error(detail || 'Ollama returned HTTP ' + res.status);
    }
    if (!res.body) throw new Error('Ollama returned an empty response body');

    let roundContent = '';
    const toolCalls = [];
    let finalStats = null;
    for await (const obj of ndjson(res.body)) {
      if (obj.error) throw new Error(obj.error);
      const msg = obj.message || {};
      roundContent += msg.content || '';
      if (Array.isArray(msg.tool_calls)) toolCalls.push(...msg.tool_calls);
      if (obj.done) {
        const evalCount = obj.eval_count || 0;
        const evalNs = obj.eval_duration || 0;
        finalStats = {
          tokens: evalCount,
          tokensPerSecond: evalNs > 0 ? evalCount / (evalNs / 1e9) : 0,
          totalSeconds: (obj.total_duration || 0) / 1e9,
        };
      }
    }

    let usedFallback = false;
    if (!toolCalls.length) {
      const inline = extractInlineToolCall(roundContent);
      if (inline) {
        usedFallback = true;
        toolCalls.push({ function: { name: inline.name, arguments: inline.arguments } });
      }
    }

    if (!toolCalls.length) {
      return { ok: true, text: roundContent, rounds: round + 1, toolLog, stats: finalStats || {} };
    }

    convo.push({ role: 'assistant', content: usedFallback ? '' : roundContent, tool_calls: toolCalls });

    for (const call of toolCalls) {
      const fn = call.function || {};
      const name = fn.name || '';
      let args = fn.arguments || {};
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { args = {}; }
      }
      let result;
      try {
        result = await runBrowserTool(name, args);
      } catch (err) {
        result = 'The browser tool failed: ' + err.message;
      }
      toolLog.push({ name, args, result: String(result).slice(0, 6000) });
      convo.push({ role: 'tool', content: result });
    }
  }

  return {
    ok: true,
    text: '(stopped after the round limit without a final answer — the tool log below shows what actually ran)',
    rounds: 6,
    toolLog,
    stats: {},
  };
}

/* 127.0.0.1-only, unauthenticated — the same trust model the browser-bridge
 * WebSocket server already uses. Anything able to reach localhost on this
 * machine could already talk to that server or to Ollama directly; this adds
 * no new exposure beyond what already exists. */
const CONTROL_PORT = Number(process.env.HGPT_CONTROL_PORT || 8770);
let controlServer = null;

function startControlServer() {
  if (controlServer) return;
  const http = require('node:http');

  controlServer = http.createServer((req, res) => {
    const remote = req.socket.remoteAddress || '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }

    if (req.method === 'GET' && req.url === '/status') {
      serverAlive().then((ollama) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ollama: !!ollama, browserLinked: extBridge.isLinked() }));
      });
      return;
    }

    // Talks to the linked browser directly, bypassing Ollama entirely — a
    // fast way to check real tab state without waiting on model generation,
    // e.g. while a slow /command call is still in flight.
    if (req.method === 'GET' && req.url === '/tabs') {
      extBridge.listTabs()
        .then((tabs) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, tabs }));
        })
        .catch((err) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        });
      return;
    }

    // Deterministic company enrichment, bypassing Ollama entirely: LinkedIn
    // about page → company website (and its contact page) → Google fallback,
    // all scripted in the extension. One POST per company.
    if (req.method === 'POST' && req.url === '/enrich') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        try {
          const parsed = JSON.parse(body || '{}');
          if (!parsed.linkedinUrl) throw new Error('linkedinUrl is required');
          const result = await extBridge.enrichCompany(parsed.linkedinUrl, parsed.companyName || '');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    // Deterministic Google Sheets cell read/write, bypassing Ollama entirely.
    // The sheet grid is a canvas with no addressable per-cell DOM, so these
    // drive it through the Name Box + formula bar (the two real DOM handles
    // into cell content) and are meant to be called directly, not by the
    // model — this is fixed mechanical data entry, not something requiring
    // judgment, and keeping a small local model out of the loop avoids it
    // mistyping cell references or values.
    // Deterministic pagination collector, no model in the loop — the model
    // route (/command) proved able to hallucinate results wholesale, which is
    // disqualifying for a data-collection pipeline.
    if (req.method === 'POST' && req.url === '/voyagerposts') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        try {
          const parsed = JSON.parse(body || '{}');
          const result = await extBridge.captureVoyagerPosts(parsed.url, parsed.settleMs);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/shadowinspect') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        try {
          const parsed = JSON.parse(body || '{}');
          const result = await extBridge.shadowInspect(parsed.url);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/inspecttime') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        try {
          const parsed = JSON.parse(body || '{}');
          const result = await extBridge.inspectTimestamp(parsed.url);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/clicktest') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        try {
          const parsed = JSON.parse(body || '{}');
          const result = await extBridge.clickTimestampTest(parsed.url);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/debugposts') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        try {
          const parsed = JSON.parse(body || '{}');
          const result = await extBridge.debugPosts(parsed.url);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/posts') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        try {
          const parsed = JSON.parse(body || '{}');
          if (!parsed.url) throw new Error('url is required');
          const result = await extBridge.linkedinPosts(parsed.url, Number(parsed.scrolls) || 6);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/page') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        try {
          const parsed = JSON.parse(body || '{}');
          if (!parsed.url) throw new Error('url is required');
          const result = await extBridge.pageFull(parsed.url, parsed.settleMs);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/collect') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        try {
          const parsed = JSON.parse(body || '{}');
          if (!parsed.url) throw new Error('url is required');
          const result = await extBridge.collectPages(
            parsed.url, Number(parsed.maxPages) || 3, parsed.nextButtonText || 'Next', parsed.filter || ''
          );
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/sheet/writeRows') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        try {
          const parsed = JSON.parse(body || '{}');
          if (!parsed.tabId || !parsed.startCell || !Array.isArray(parsed.rowsValues)) throw new Error('tabId, startCell and rowsValues[] are required');
          const result = await extBridge.writeSheetRows(parsed.tabId, parsed.startCell, parsed.rowsValues);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/sheet/paste') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        try {
          const parsed = JSON.parse(body || '{}');
          if (!parsed.tabId || !parsed.cell) throw new Error('tabId and cell are both required');
          const result = await extBridge.pasteSheet(parsed.tabId, parsed.cell);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/sheet/deleteRows') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        try {
          const parsed = JSON.parse(body || '{}');
          if (!parsed.tabId || !Array.isArray(parsed.rows) || !parsed.rows.length) throw new Error('tabId and rows[] are required');
          const result = await extBridge.deleteSheetRows(parsed.tabId, parsed.rows.map(Number));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/sheet/deleteRow') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        try {
          const parsed = JSON.parse(body || '{}');
          if (!parsed.tabId || !parsed.row) throw new Error('tabId and row are both required');
          const result = await extBridge.deleteSheetRow(parsed.tabId, Number(parsed.row));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/sheet/key') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        try {
          const parsed = JSON.parse(body || '{}');
          if (!parsed.tabId || !parsed.key) throw new Error('tabId and key are both required');
          const result = await extBridge.pressSheetKey(parsed.tabId, parsed.key);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    if (req.method === 'POST' && (req.url === '/sheet/write' || req.url === '/sheet/read' || req.url === '/sheet/writeRow')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        try {
          const parsed = JSON.parse(body || '{}');
          if (!parsed.tabId) throw new Error('tabId is required');
          let result;
          if (req.url === '/sheet/writeRow') {
            if (!parsed.startCell || !Array.isArray(parsed.values)) throw new Error('startCell and values[] are required');
            result = await extBridge.writeSheetRow(parsed.tabId, parsed.startCell, parsed.values);
          } else if (!parsed.cell) {
            throw new Error('cell is required');
          } else if (req.url === '/sheet/write') {
            result = await extBridge.writeSheetCell(parsed.tabId, parsed.cell, parsed.value);
          } else {
            result = await extBridge.readSheetCell(parsed.tabId, parsed.cell);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/command') {
      // A disconnected client must actually cancel the underlying Ollama
      // generation, not just stop waiting on it — this server previously let
      // an abandoned request keep running, and with OLLAMA_NUM_PARALLEL=1
      // that one stuck generation blocked every other request on the entire
      // Ollama server, including unrelated ones, until Ollama was restarted.
      const abort = new AbortController();
      let clientGone = false;
      const goneNow = () => {
        if (clientGone) return;
        clientGone = true;
        abort.abort();
      };
      req.on('error', goneNow);
      res.on('error', goneNow);
      res.on('close', () => { if (!res.writableEnded) goneNow(); });

      const safeRespond = (code, payload) => {
        if (clientGone || res.writableEnded) return;
        try {
          res.writeHead(code, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        } catch { /* the client is gone; nothing more to do */ }
      };

      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        try {
          const parsed = JSON.parse(body || '{}');
          if (!parsed.prompt || !parsed.model) throw new Error('prompt and model are both required');
          const result = await runHeadlessTurn(parsed.model, parsed.prompt, {
            numCtx: parsed.numCtx, numPredict: parsed.numPredict, signal: abort.signal,
          });
          safeRespond(200, result);
        } catch (err) {
          if (err.name !== 'AbortError') safeRespond(400, { ok: false, error: err.message });
        }
      });
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });

  controlServer.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  controlServer.on('error', (err) => console.error('control server error:', err.message));
  controlServer.listen(CONTROL_PORT, '127.0.0.1');
}

ipcMain.handle('chat:send', async (event, payload) => {
  const { requestId, model, messages, options, browserTools } = payload;
  const ctl = new AbortController();
  activeRequests.set(requestId, ctl);

  // NOTE: we deliberately never send `think: false`.
  // On Ollama 0.32 that does not stop a reasoning model from reasoning — it only
  // stops Ollama parsing the reasoning into `message.thinking`, so the raw chain of
  // thought (plus a stray </think>) leaks into the visible answer.
  const baseOptions = {
    temperature: (options && options.temperature) != null ? options.temperature : 0.7,
    top_p: (options && options.topP) != null ? options.topP : 0.9,
    num_ctx: (options && options.numCtx) != null ? options.numCtx : 2048,
  };
  if (options && options.numThread) baseOptions.num_thread = options.numThread;
  if (options && options.numGpu != null && options.numGpu >= 0) baseOptions.num_gpu = options.numGpu;

  const convo = messages.slice();
  let contentSoFar = '';
  let leakHandled = false;
  let toolsUnsupported = false;

  try {
    // Each pass either produces a final answer or asks for a tool; at most a few
    // rounds so a confused model cannot loop forever.
    for (let round = 0; round < 4; round++) {
      const body = { model, messages: convo, stream: true, options: baseOptions };
      if (browserTools && !toolsUnsupported) body.tools = BROWSER_TOOLS;

      const res = await fetch(OLLAMA_HOST + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });

      if (!res.ok) {
        let detail = '';
        try { detail = (await res.json()).error || ''; } catch { /* ignore */ }
        // Not every model accepts tools; drop them and try once more.
        if (!toolsUnsupported && /tool/i.test(detail) && /support/i.test(detail)) {
          toolsUnsupported = true;
          continue;
        }
        throw new Error(detail || 'Ollama returned HTTP ' + res.status);
      }
      if (!res.body) throw new Error('Ollama returned an empty response body');

      let roundContent = '';
      const toolCalls = [];
      let finalStats = null;

      for await (const obj of ndjson(res.body)) {
        if (obj.error) throw new Error(obj.error);

        const msg = obj.message || {};
        const content = msg.content || '';
        const thinking = msg.thinking || '';
        if (Array.isArray(msg.tool_calls)) toolCalls.push(...msg.tool_calls);

        if (content || thinking) {
          roundContent += content;
          event.sender.send('chat:chunk', { requestId, content, thinking });
        }

        if (content && !leakHandled) {
          contentSoFar += content;
          const close = contentSoFar.indexOf('</think>');
          if (close >= 0) {
            leakHandled = true;
            const before = contentSoFar.slice(0, close).replace(/^\s*<think>/, '').trim();
            const after = contentSoFar.slice(close + '</think>'.length).replace(/^\s+/, '');
            event.sender.send('chat:reclassify', { requestId, thinking: before, content: after });
          }
        }

        if (obj.done) {
          const evalCount = obj.eval_count || 0;
          const evalNs = obj.eval_duration || 0;
          finalStats = {
            tokens: evalCount,
            promptTokens: obj.prompt_eval_count || 0,
            tokensPerSecond: evalNs > 0 ? evalCount / (evalNs / 1e9) : 0,
            totalSeconds: (obj.total_duration || 0) / 1e9,
            loadSeconds: (obj.load_duration || 0) / 1e9,
          };
        }
      }

      let usedFallbackParse = false;
      if (!toolCalls.length) {
        const inline = extractInlineToolCall(roundContent);
        if (inline) {
          usedFallbackParse = true;
          toolCalls.push({ function: { name: inline.name, arguments: inline.arguments } });
          // The raw JSON was already streamed to the chat bubble as plain text
          // before we could detect it; tell the renderer to drop just that
          // much, so a tool row appears in its place instead of leaked JSON.
          event.sender.send('chat:trimContent', { requestId, chars: roundContent.length });
        }
      }

      if (!toolCalls.length) {
        event.sender.send('chat:done', { requestId, stats: finalStats || {} });
        return { ok: true };
      }

      // Run what the model asked for, then let it answer with the results.
      // When the call was recovered from leaked text rather than a real
      // tool_calls entry, drop that text from history — otherwise the model
      // sees its own malformed attempt reflected back and imitates it again.
      convo.push({
        role: 'assistant',
        content: usedFallbackParse ? '' : roundContent,
        tool_calls: toolCalls,
      });

      for (const call of toolCalls) {
        const fn = (call.function || {});
        const name = fn.name || '';
        let args = fn.arguments || {};
        if (typeof args === 'string') {
          try { args = JSON.parse(args); } catch { args = {}; }
        }
        event.sender.send('chat:tool', {
          requestId, name,
          detail: args.url ? String(args.url) : '',
          state: 'running',
        });

        let result;
        try {
          result = await runBrowserTool(name, args);
          event.sender.send('chat:tool', { requestId, name, detail: args.url || '', state: 'done' });
        } catch (err) {
          result = 'The browser tool failed: ' + err.message;
          event.sender.send('chat:tool', { requestId, name, detail: err.message, state: 'error' });
        }
        convo.push({ role: 'tool', content: result });
      }
    }

    event.sender.send('chat:done', { requestId, stats: {} });
    return { ok: true };
  } catch (err) {
    if (err.name === 'AbortError') {
      event.sender.send('chat:done', { requestId, cancelled: true });
      return { ok: false, cancelled: true };
    }
    event.sender.send('chat:error', { requestId, error: err.message });
    return { ok: false, error: err.message };
  } finally {
    activeRequests.delete(requestId);
  }
});

ipcMain.handle('chat:abort', async (_e, requestId) => {
  const ctl = activeRequests.get(requestId);
  if (ctl) { ctl.abort(); return true; }
  return false;
});

/* ------------------------------------------------------------------ */
/* Video generation (ComfyUI + LTX-Video)                               */
/* ------------------------------------------------------------------ */

/* Where generated clips are written. Kept in its own small config file so the
   renderer's settings.json cannot race with it, and defaulted to the roomiest
   fixed drive rather than the system drive. */
const videoConfigPath = () => path.join(storeDir(), 'video-config.json');

function defaultVideoDir() {
  for (const root of ['D:\\', 'E:\\', 'G:\\']) {
    try {
      if (fs.existsSync(root)) return path.join(root, 'Hanzla-GPT', 'Videos');
    } catch { /* ignore */ }
  }
  return path.join(storeDir(), 'videos');
}

let videoDirCache = null;

function videoDir() {
  if (videoDirCache) return videoDirCache;
  try {
    const cfg = JSON.parse(fs.readFileSync(videoConfigPath(), 'utf8'));
    if (cfg && typeof cfg.dir === 'string' && cfg.dir.trim()) {
      videoDirCache = cfg.dir;
      return videoDirCache;
    }
  } catch { /* no config yet */ }
  videoDirCache = defaultVideoDir();
  return videoDirCache;
}

async function setVideoDir(dir) {
  videoDirCache = dir;
  await fsp.mkdir(storeDir(), { recursive: true });
  await fsp.writeFile(videoConfigPath(), JSON.stringify({ dir }, null, 2), 'utf8');
  await fsp.mkdir(dir, { recursive: true }).catch(() => {});
  return dir;
}

ipcMain.handle('video:getDir', async () => {
  const dir = videoDir();
  let writable = true;
  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.access(dir, fs.constants.W_OK);
  } catch { writable = false; }
  return { dir, writable, isDefault: dir === defaultVideoDir() };
});

ipcMain.handle('video:chooseDir', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose where to save generated videos',
    defaultPath: videoDir(),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return { cancelled: true };
  return { dir: await setVideoDir(res.filePaths[0]) };
});

ipcMain.handle('video:openDir', async () => {
  const dir = videoDir();
  await fsp.mkdir(dir, { recursive: true }).catch(() => {});
  await shell.openPath(dir);
  return dir;
});

async function comfyAlive(timeoutMs = 2500) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(COMFY_HOST + '/system_stats', { signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

ipcMain.handle('comfy:status', async () => {
  const installed = fs.existsSync(path.join(COMFY_ROOT, 'ComfyUI', 'main.py'));
  const s = await comfyAlive();
  if (!s) return { running: false, installed };
  const dev = (s.devices && s.devices[0]) || {};
  return {
    running: true,
    installed: true,
    device: dev.name || 'unknown',
    vramTotal: dev.vram_total || 0,
    vramFree: dev.vram_free || 0,
  };
});

ipcMain.handle('comfy:start', async () => {
  if (await comfyAlive()) return { running: true };
  const py = path.join(COMFY_ROOT, 'python_embeded', 'python.exe');
  if (!fs.existsSync(py)) return { running: false, error: 'ComfyUI not found at ' + COMFY_ROOT };
  try {
    await fsp.mkdir(storeDir(), { recursive: true });
    // Keep the engine's own output so a crash can actually be diagnosed.
    const logFd = fs.openSync(path.join(storeDir(), 'engine.log'), 'a');
    const child = spawn(py, [
      '-s', 'ComfyUI/main.py',
      '--port', '8188',
      '--disable-auto-launch',
      '--lowvram',
      // Without this ComfyUI keeps the previous checkpoint cached and the second
      // generation dies re-instantiating a 6 GB model on top of it.
      '--disable-smart-memory',
    ], {
      cwd: COMFY_ROOT, detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true,
    });
    child.unref();
  } catch (err) {
    return { running: false, error: err.message };
  }
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    if (await comfyAlive()) return { running: true, started: true };
  }
  return { running: false, error: 'ComfyUI did not respond within 3 minutes' };
});

/* Which engines have their weights on disk. */
/* Step-distillation LoRA. Measured on this machine at 480x272/25 frames:
   30 steps without it took 1499s; 10 steps with it at strength 0.40 and
   cfg 1.5 took roughly 500s for comparable, still-photoreal output. */
const CAUSVID_LORA = 'Wan21_CausVid_bidirect2_T2V_1_3B_lora_rank32.safetensors';

const ENGINE_FILES = {
  wan22: [
    ['diffusion_models', 'wan2.2_ti2v_5B_fp16.safetensors'],
    ['text_encoders', 'umt5_xxl_fp8_e4m3fn_scaled.safetensors'],
    ['vae', 'wan2.2_vae.safetensors'],
  ],
  wan: [
    ['diffusion_models', 'wan2.1_t2v_1.3B_fp16.safetensors'],
    ['text_encoders', 'umt5_xxl_fp8_e4m3fn_scaled.safetensors'],
    ['vae', 'wan_2.1_vae.safetensors'],
  ],
};

ipcMain.handle('comfy:hasFastMode', async () =>
  fs.existsSync(path.join(COMFY_ROOT, 'ComfyUI', 'models', 'loras', CAUSVID_LORA)));

ipcMain.handle('comfy:engines', async () => {
  const out = {};
  for (const [id, files] of Object.entries(ENGINE_FILES)) {
    out[id] = files.every(([dir, name]) =>
      fs.existsSync(path.join(COMFY_ROOT, 'ComfyUI', 'models', dir, name)));
  }
  return out;
});

/* WAN 2.1 handles people and realistic motion far better than LTX. It needs
   frame counts of the form 4n+1 and runs natively at 16 fps. */
function wanWorkflow(p) {
  let length = Math.max(5, Math.round(p.length || 33));
  length = Math.round((length - 1) / 4) * 4 + 1;

  const fast = p.quality === 'fast';
  const steps = fast ? 10 : 30;
  const cfg = fast ? 1.5 : 6.0;

  const wf = {
    unet: { class_type: 'UNETLoader', inputs: {
              unet_name: 'wan2.1_t2v_1.3B_fp16.safetensors', weight_dtype: 'default' } },
    clip: { class_type: 'CLIPLoader', inputs: {
              clip_name: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', type: 'wan' } },
    vae:  { class_type: 'VAELoader', inputs: { vae_name: 'wan_2.1_vae.safetensors' } },
    pos:  { class_type: 'CLIPTextEncode', inputs: { text: p.prompt, clip: ['clip', 0] } },
    neg:  { class_type: 'CLIPTextEncode', inputs: { text: p.negative || '', clip: ['clip', 0] } },
    lat:  { class_type: 'EmptyHunyuanLatentVideo', inputs: {
              width: p.width, height: p.height, length: length, batch_size: 1 } },
    samp: { class_type: 'KSampler', inputs: {
              model: ['shift', 0], positive: ['pos', 0], negative: ['neg', 0], latent_image: ['lat', 0],
              seed: p.seed, steps: steps, cfg: cfg,
              sampler_name: 'uni_pc', scheduler: 'simple', denoise: 1.0 } },
    dec:  decodeNode(p, ['vae', 0]),
    save: { class_type: 'SaveWEBM', inputs: {
              images: ['dec', 0], filename_prefix: 'hanzla_wan', codec: 'vp9', fps: 16.0, crf: 32.0 } },
  };

  if (fast) {
    wf.lora = { class_type: 'LoraLoaderModelOnly', inputs: {
                  model: ['unet', 0], lora_name: CAUSVID_LORA, strength_model: 0.40 } };
  }
  wf.shift = { class_type: 'ModelSamplingSD3', inputs: {
                 model: fast ? ['lora', 0] : ['unet', 0], shift: 8.0 } };
  return wf;
}

/* Uploads a reference photo into ComfyUI so a workflow can load it by name. */
ipcMain.handle('comfy:uploadImage', async (_e, filePath) => {
  const buf = await fsp.readFile(filePath);
  const name = path.basename(filePath);
  const form = new FormData();
  form.append('image', new Blob([buf]), name);
  form.append('overwrite', 'true');
  const res = await fetch(COMFY_HOST + '/upload/image', { method: 'POST', body: form });
  if (!res.ok) throw new Error('Upload failed (HTTP ' + res.status + ')');
  const j = await res.json();
  return { name: j.name, subfolder: j.subfolder || '' };
});

ipcMain.handle('video:pickImage', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a reference photo',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }],
  });
  if (res.canceled || !res.filePaths.length) return { cancelled: true };
  return { path: res.filePaths[0] };
});

/* WAN 2.2 TI2V-5B. Handles text-to-video, and image-to-video when a reference
   photo is supplied — which is the only way to pin a specific real person's
   likeness, because no open model recognises people by name. */
/* Tiled decoding leaves seams, so only use it when a plain decode would risk
   exhausting the 4 GB of VRAM. */
function decodeNode(p, vaeRef) {
  const heavy = p.width * p.height > 512 * 320;
  return heavy
    ? { class_type: 'VAEDecodeTiled', inputs: {
          samples: ['samp', 0], vae: vaeRef,
          tile_size: 512, overlap: 64, temporal_size: 32, temporal_overlap: 8 } }
    : { class_type: 'VAEDecode', inputs: { samples: ['samp', 0], vae: vaeRef } };
}

function wan22Workflow(p) {
  let length = Math.max(5, Math.round(p.length || 49));
  length = Math.round((length - 1) / 4) * 4 + 1;

  const wf = {
    unet: { class_type: 'UNETLoader', inputs: {
              unet_name: 'wan2.2_ti2v_5B_fp16.safetensors', weight_dtype: 'default' } },
    clip: { class_type: 'CLIPLoader', inputs: {
              clip_name: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', type: 'wan' } },
    vae:  { class_type: 'VAELoader', inputs: { vae_name: 'wan2.2_vae.safetensors' } },
    pos:  { class_type: 'CLIPTextEncode', inputs: { text: p.prompt, clip: ['clip', 0] } },
    neg:  { class_type: 'CLIPTextEncode', inputs: { text: p.negative || '', clip: ['clip', 0] } },
    shift:{ class_type: 'ModelSamplingSD3', inputs: { model: ['unet', 0], shift: 8.0 } },
    samp: { class_type: 'KSampler', inputs: {
              model: ['shift', 0], positive: ['pos', 0], negative: ['neg', 0], latent_image: ['lat', 0],
              seed: p.seed, steps: 30, cfg: 5.0,
              sampler_name: 'uni_pc', scheduler: 'simple', denoise: 1.0 } },
    dec:  decodeNode(p, ['vae', 0]),
    save: { class_type: 'SaveWEBM', inputs: {
              images: ['dec', 0], filename_prefix: 'hanzla_wan22', codec: 'vp9', fps: 24.0, crf: 32.0 } },
  };

  if (p.imageName) {
    wf.img = { class_type: 'LoadImage', inputs: { image: p.imageName } };
    wf.fit = { class_type: 'ImageScale', inputs: {
                 image: ['img', 0], width: p.width, height: p.height,
                 upscale_method: 'lanczos', crop: 'center' } };
    wf.lat = { class_type: 'Wan22ImageToVideoLatent', inputs: {
                 vae: ['vae', 0], width: p.width, height: p.height,
                 length: length, batch_size: 1, start_image: ['fit', 0] } };
  } else {
    wf.lat = { class_type: 'Wan22ImageToVideoLatent', inputs: {
                 vae: ['vae', 0], width: p.width, height: p.height,
                 length: length, batch_size: 1 } };
  }
  return wf;
}

const videoJobs = new Map();   // requestId -> { cancelled }

ipcMain.handle('comfy:generate', async (event, params) => {
  const { requestId } = params;
  const job = { cancelled: false };
  videoJobs.set(requestId, job);
  const started = Date.now();
  const tick = (stage, detail) => event.sender.send('video:progress', {
    requestId, stage, detail, elapsed: (Date.now() - started) / 1000,
  });

  try {
    if (!(await comfyAlive())) throw new Error('ComfyUI is not running — press Start engine first.');

    tick('queued', 'Sending job to ComfyUI');
    const res = await fetch(COMFY_HOST + '/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: params.engine === 'wan' ? wanWorkflow(params) : wan22Workflow(params),
        client_id: 'hanzla-gpt',
      }),
    });
    if (!res.ok) {
      const txt = await res.text();
      let msg = txt;
      try {
        const j = JSON.parse(txt);
        msg = (j.error && (j.error.message || j.error.type)) || txt;
        if (j.node_errors && Object.keys(j.node_errors).length) {
          msg += ' - ' + JSON.stringify(j.node_errors).slice(0, 300);
        }
      } catch { /* keep the raw body */ }
      throw new Error(String(msg).slice(0, 500));
    }
    const submitted = await res.json();
    const promptId = submitted.prompt_id;

    // ComfyUI's HTTP server can briefly refuse connections while the GPU is
    // saturated. A dropped poll is not a failed job, so retry instead of giving up.
    let consecutiveNetworkErrors = 0;
    const getJson = async (pathname) => {
      const r = await fetch(COMFY_HOST + pathname);
      if (!r.ok) throw new Error('HTTP ' + r.status + ' from ' + pathname);
      return r.json();
    };

    for (;;) {
      if (job.cancelled) throw Object.assign(new Error('cancelled'), { cancelled: true });
      await new Promise((r) => setTimeout(r, 1500));

      let hist;
      try {
        hist = await getJson('/history/' + promptId);
        consecutiveNetworkErrors = 0;
      } catch (err) {
        if (++consecutiveNetworkErrors > 40) {
          throw new Error('Lost contact with ComfyUI: ' + err.message);
        }
        tick('generating', 'Engine busy, still working');
        continue;
      }

      if (hist && hist[promptId]) {
        const entry = hist[promptId];
        const st = entry.status || {};
        if (st.status_str === 'error') {
          const em = (st.messages || []).find((m) => m[0] === 'execution_error');
          throw new Error(em ? String(em[1].exception_message || 'Execution error').slice(0, 400) : 'Execution error');
        }
        const files = [];
        for (const out of Object.values(entry.outputs || {})) {
          for (const k of ['images', 'gifs', 'videos']) {
            for (const f of out[k] || []) files.push(f);
          }
        }
        if (!files.length) throw new Error('ComfyUI finished but produced no file');

        tick('saving', 'Fetching the finished clip');
        const f = files[files.length - 1];
        const url = COMFY_HOST + '/view?filename=' + encodeURIComponent(f.filename) +
          '&subfolder=' + encodeURIComponent(f.subfolder || '') +
          '&type=' + encodeURIComponent(f.type || 'output');
        const buf = Buffer.from(await (await fetch(url)).arrayBuffer());

        await fsp.mkdir(videoDir(), { recursive: true });
        const name = 'hanzla-' + Date.now() + '-' + String(f.filename).replace(/[^\w.\-]/g, '');
        await fsp.writeFile(path.join(videoDir(), name), buf);

        return { ok: true, file: name, bytes: buf.length, seconds: (Date.now() - started) / 1000 };
      }

      try {
        const q = await getJson('/queue');
        const running = (q.queue_running || []).length > 0;
        tick(running ? 'generating' : 'waiting', running ? 'Model is sampling' : 'Waiting in queue');
      } catch {
        tick('generating', 'Engine busy, still working');
      }
    }
  } catch (err) {
    if (err.cancelled) return { ok: false, cancelled: true };
    return { ok: false, error: err.message };
  } finally {
    videoJobs.delete(requestId);
  }
});

ipcMain.handle('comfy:cancel', async (_e, requestId) => {
  const job = videoJobs.get(requestId);
  if (job) job.cancelled = true;
  try { await fetch(COMFY_HOST + '/interrupt', { method: 'POST' }); } catch { /* ignore */ }
  return true;
});

ipcMain.handle('video:list', async () => {
  try {
    const names = await fsp.readdir(videoDir());
    const out = [];
    for (const n of names.filter((x) => /\.(webm|mp4|webp|gif)$/i.test(x))) {
      const st = await fsp.stat(path.join(videoDir(), n));
      out.push({ file: n, bytes: st.size, at: st.mtimeMs });
    }
    return out.sort((a, b) => b.at - a.at);
  } catch { return []; }
});

ipcMain.handle('video:reveal', async (_e, file) => {
  shell.showItemInFolder(path.join(videoDir(), path.basename(file)));
});

ipcMain.handle('video:delete', async (_e, file) => {
  // basename() guards against path traversal from the renderer.
  await fsp.unlink(path.join(videoDir(), path.basename(file)));
  return true;
});

/* ------------------------------------------------------------------ */
/* IPC: benchmark                                                       */
/* ------------------------------------------------------------------ */

const BENCH_PROMPT = 'Count from 1 to 40, separated by spaces. Output nothing else.';

async function benchOne(model, opts) {
  const t0 = Date.now();
  const res = await fetch(OLLAMA_HOST + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: BENCH_PROMPT }],
      stream: false,
      options: Object.assign({ num_ctx: 2048, temperature: 0 }, opts || {}),
    }),
  });
  if (!res.ok) {
    let d = '';
    try { d = (await res.json()).error || ''; } catch { /* ignore */ }
    throw new Error(d || 'HTTP ' + res.status);
  }
  const data = await res.json();

  // Ask Ollama where the weights actually ended up.
  let vram = 0, total = 0;
  try {
    const ps = await (await fetch(OLLAMA_HOST + '/api/ps')).json();
    const hit = (ps.models || []).find((m) => m.name === model || m.model === model);
    if (hit) { vram = hit.size_vram || 0; total = hit.size || 0; }
  } catch { /* ignore */ }

  const evalCount = data.eval_count || 0;
  const evalNs = data.eval_duration || 0;
  return {
    model,
    tokens: evalCount,
    tokensPerSecond: evalNs > 0 ? evalCount / (evalNs / 1e9) : 0,
    loadSeconds: (data.load_duration || 0) / 1e9,
    wallSeconds: (Date.now() - t0) / 1000,
    sizeVram: vram,
    sizeTotal: total,
    gpuFraction: total > 0 ? vram / total : 0,
  };
}

ipcMain.handle('ollama:benchmark', async (event, { models, options, requestId }) => {
  const out = [];
  for (const m of models) {
    event.sender.send('bench:progress', { requestId, model: m, state: 'running' });
    try {
      const r = await benchOne(m, options);
      out.push(r);
      event.sender.send('bench:progress', { requestId, model: m, state: 'done', result: r });
    } catch (err) {
      const bad = { model: m, error: err.message };
      out.push(bad);
      event.sender.send('bench:progress', { requestId, model: m, state: 'error', result: bad });
    }
  }
  return out;
});

ipcMain.handle('sys:info', async () => {
  const os = require('node:os');
  const cpus = os.cpus();
  return {
    cpuModel: cpus.length ? cpus[0].model : 'unknown',
    logicalCores: cpus.length,
    totalMemGb: os.totalmem() / 1024 ** 3,
    freeMemGb: os.freemem() / 1024 ** 3,
  };
});

/* ------------------------------------------------------------------ */
/* IPC: browser link                                                    */
/* ------------------------------------------------------------------ */

ipcMain.handle('ext:status', async () => extBridge.status());
ipcMain.handle('ext:tabs', async () => {
  try { return await extBridge.listTabs(); } catch { return []; }
});
ipcMain.handle('ext:readTab', async (_e, tabId) => {
  try { return { ok: true, page: await extBridge.readTab(tabId) }; } catch (err) { return { ok: false, error: err.message }; }
});
function extensionDir() {
  // In dev this is the project's own extension/ folder. Packaged, it cannot live
  // inside app.asar (Explorer cannot open a path inside a virtual archive), so
  // electron-builder copies it out to resources/extension as a real folder.
  return app.isPackaged
    ? path.join(process.resourcesPath, 'extension')
    : path.join(__dirname, '..', 'extension');
}

ipcMain.handle('ext:openFolder', async () => {
  const dir = extensionDir();
  const err = await shell.openPath(dir);
  if (err) return { error: err, dir };
  return { dir };
});

/* ------------------------------------------------------------------ */
/* IPC: store + misc                                                    */
/* ------------------------------------------------------------------ */

ipcMain.handle('store:get', async (_e, name) => readJson(name, null));
ipcMain.handle('store:set', async (_e, { name, value }) => { await writeJson(name, value); return true; });
ipcMain.handle('app:paths', async () => ({ userData: storeDir(), models: process.env.OLLAMA_MODELS || '(default)' }));
ipcMain.handle('app:openExternal', async (_e, url) => {
  if (/^https?:\/\//i.test(url)) await shell.openExternal(url);
});
ipcMain.handle('app:saveFile', async (_e, { suggestedName, contents }) => {
  const ext = String(suggestedName).split('.').pop();
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: suggestedName,
    filters: [{ name: ext.toUpperCase() + ' file', extensions: [ext] }, { name: 'All files', extensions: ['*'] }],
  });
  if (canceled || !filePath) return false;
  await fsp.writeFile(filePath, contents, 'utf8');
  return filePath;
});

ipcMain.handle('app:exportChat', async (_e, { suggestedName, contents }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: suggestedName,
    filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (canceled || !filePath) return false;
  await fsp.writeFile(filePath, contents, 'utf8');
  return filePath;
});
