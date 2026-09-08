'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const { Marked } = require('marked');
const createDOMPurify = require('dompurify');
const hljs = require('highlight.js');

/* ------------------------------------------------------------------ */
/* Markdown rendering happens here (Node side), so the renderer stays   */
/* sandboxed and only ever receives sanitized HTML.                     */
/*                                                                      */
/* Two modes:                                                           */
/*   renderMessage() — fenced code becomes a compact CARD; the code     */
/*                     itself is returned separately for the side panel */
/*   md()           — plain rendering, code stays inline                */
/* ------------------------------------------------------------------ */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function resolveLang(code, lang) {
  const l = (lang || '').split(/\s+/)[0].toLowerCase();
  if (l && hljs.getLanguage(l)) return l;
  if (l) return l; // unknown but explicit — keep the author's label
  const auto = hljs.highlightAuto(code);
  return auto.language || 'text';
}

function highlight(code, lang) {
  if (lang && hljs.getLanguage(lang)) {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  }
  return escapeHtml(code);
}

const LANG_LABEL = {
  js: 'JavaScript', javascript: 'JavaScript', ts: 'TypeScript', typescript: 'TypeScript',
  py: 'Python', python: 'Python', cs: 'C#', csharp: 'C#', cpp: 'C++', c: 'C',
  java: 'Java', go: 'Go', rust: 'Rust', rb: 'Ruby', ruby: 'Ruby', php: 'PHP',
  sh: 'Shell', bash: 'Shell', shell: 'Shell', powershell: 'PowerShell', ps1: 'PowerShell',
  sql: 'SQL', html: 'HTML', css: 'CSS', json: 'JSON', yaml: 'YAML', yml: 'YAML',
  xml: 'XML', md: 'Markdown', markdown: 'Markdown', text: 'Text',
};
const prettyLang = (l) => LANG_LABEL[l] || (l ? l.toUpperCase() : 'Text');

/* --- marked instance that emits code CARDS ------------------------- */

let collected = [];

const markedCards = new Marked({ gfm: true, breaks: true });
markedCards.use({
  renderer: {
    code(token) {
      const raw = token.text || '';
      const lang = resolveLang(raw, token.lang);
      const idx = collected.length;
      const lines = raw.split('\n').length;
      collected.push({ index: idx, lang, code: raw, lines });
      return (
        '<button class="code-card" type="button" data-idx="' + idx + '">' +
        // Plain text glyph rather than inline SVG: the sanitizer strips foreign
        // (SVG-namespace) nodes, which left an empty box in the card.
        '<span class="cc-glyph">&lt;/&gt;</span>' +
        '<span class="cc-body"><span class="cc-title">' + escapeHtml(prettyLang(lang)) + '</span>' +
        '<span class="cc-sub">' + lines + (lines === 1 ? ' line' : ' lines') + '</span></span>' +
        '<span class="cc-cta">View</span>' +
        '</button>'
      );
    },
  },
});

/* --- marked instance that keeps code inline ------------------------ */

const markedInline = new Marked({ gfm: true, breaks: true });
markedInline.use({
  renderer: {
    code(token) {
      const raw = token.text || '';
      const lang = resolveLang(raw, token.lang);
      return (
        '<div class="inline-code-block"><pre><code class="hljs">' +
        highlight(raw, lang) +
        '</code></pre></div>'
      );
    },
  },
});

let purifier = null;
function getPurifier() {
  if (!purifier) {
    purifier = createDOMPurify(window);
    purifier.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A') {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    });
  }
  return purifier;
}

const PURIFY_OPTS = {
  ADD_ATTR: ['target', 'rel', 'data-idx', 'class', 'viewBox', 'fill', 'd', 'width', 'height', 'aria-hidden'],
  ADD_TAGS: ['svg', 'path'],
  ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i,
};

function renderMessage(text) {
  collected = [];
  const html = markedCards.parse(String(text || ''));
  const clean = getPurifier().sanitize(html, PURIFY_OPTS);
  return { html: clean, blocks: collected.slice() };
}

function md(text) {
  return getPurifier().sanitize(markedInline.parse(String(text || '')), PURIFY_OPTS);
}

/* Highlighted HTML for one code block, for the side panel. */
function highlightBlock(code, lang) {
  return getPurifier().sanitize(
    '<pre><code class="hljs">' + highlight(String(code || ''), lang) + '</code></pre>',
    PURIFY_OPTS
  );
}

/* ------------------------------------------------------------------ */
/* Bridge                                                               */
/* ------------------------------------------------------------------ */

function on(channel, cb) {
  const wrapped = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('api', {
  renderMessage,
  md,
  highlightBlock,
  prettyLang,

  ensureServer: () => ipcRenderer.invoke('ollama:ensure'),
  listModels: () => ipcRenderer.invoke('ollama:models'),
  listRunning: () => ipcRenderer.invoke('ollama:running'),
  deleteModel: (name) => ipcRenderer.invoke('ollama:delete', name),
  pullModel: (name, requestId) => ipcRenderer.invoke('ollama:pull', { name, requestId }),

  benchmark: (models, options, requestId) => ipcRenderer.invoke('ollama:benchmark', { models, options, requestId }),
  onBenchProgress: (cb) => on('bench:progress', cb),
  sysInfo: () => ipcRenderer.invoke('sys:info'),

  extStatus: () => ipcRenderer.invoke('ext:status'),
  extTabs: () => ipcRenderer.invoke('ext:tabs'),
  openExtensionFolder: () => ipcRenderer.invoke('ext:openFolder'),
  extReadTab: (id) => ipcRenderer.invoke('ext:readTab', id),

  comfyStatus: () => ipcRenderer.invoke('comfy:status'),
  comfyEngines: () => ipcRenderer.invoke('comfy:engines'),
  hasFastMode: () => ipcRenderer.invoke('comfy:hasFastMode'),
  comfyStart: () => ipcRenderer.invoke('comfy:start'),
  generateVideo: (params) => ipcRenderer.invoke('comfy:generate', params),
  cancelVideo: (requestId) => ipcRenderer.invoke('comfy:cancel', requestId),
  onVideoProgress: (cb) => on('video:progress', cb),
  pickImage: () => ipcRenderer.invoke('video:pickImage'),
  uploadImage: (p) => ipcRenderer.invoke('comfy:uploadImage', p),
  getVideoDir: () => ipcRenderer.invoke('video:getDir'),
  chooseVideoDir: () => ipcRenderer.invoke('video:chooseDir'),
  openVideoDir: () => ipcRenderer.invoke('video:openDir'),
  listVideos: () => ipcRenderer.invoke('video:list'),
  revealVideo: (f) => ipcRenderer.invoke('video:reveal', f),
  deleteVideo: (f) => ipcRenderer.invoke('video:delete', f),

  send: (payload) => ipcRenderer.invoke('chat:send', payload),
  abort: (requestId) => ipcRenderer.invoke('chat:abort', requestId),

  onChunk: (cb) => on('chat:chunk', cb),
  onReclassify: (cb) => on('chat:reclassify', cb),
  onTrimContent: (cb) => on('chat:trimContent', cb),
  onToolEvent: (cb) => on('chat:tool', cb),
  onDone: (cb) => on('chat:done', cb),
  onError: (cb) => on('chat:error', cb),
  onPullProgress: (cb) => on('pull:progress', cb),
  onPullDone: (cb) => on('pull:done', cb),
  onNewChat: (cb) => on('menu:new-chat', cb),
  onFlush: (cb) => on('app:flush', cb),
  flushed: () => ipcRenderer.invoke('app:flushed'),
  onRenameChat: (cb) => on('menu:rename-chat', cb),

  storeGet: (name) => ipcRenderer.invoke('store:get', name),
  storeSet: (name, value) => ipcRenderer.invoke('store:set', { name, value }),
  paths: () => ipcRenderer.invoke('app:paths'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  exportChat: (suggestedName, contents) => ipcRenderer.invoke('app:exportChat', { suggestedName, contents }),
  saveFile: (suggestedName, contents) => ipcRenderer.invoke('app:saveFile', { suggestedName, contents }),
});
