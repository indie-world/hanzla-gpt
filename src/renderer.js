'use strict';

/* ------------------------------------------------------------------ */
/* State                                                                */
/* ------------------------------------------------------------------ */

const DEFAULT_SETTINGS = {
  systemPrompt: 'You are a helpful, direct assistant. Be concise unless asked for detail.',
  temperature: 0.7,
  numCtx: 2048,
  showThinking: true,
  numThread: 0,     // 0 = let Ollama decide
  numGpu: -1,       // -1 = automatic layer offload
  lastModel: '',
  codePanelWidth: 460,
};

let settings = { ...DEFAULT_SETTINGS };
let conversations = [];
let currentId = null;
let activeRequestId = null;
let models = [];
let privateMode = false;   // private chats are never written to disk

const $ = (sel) => document.querySelector(sel);
const el = {
  chatList: $('#chat-list'),
  messages: $('#messages'),
  empty: $('#empty-state'),
  input: $('#input'),
  send: $('#send'),
  stop: $('#stop'),
  modelSelect: $('#model-select'),
  modelMeta: $('#model-meta'),
  status: $('#server-status'),
  panel: $('#code-panel'),
  cpTabs: $('#cp-tabs'),
  cpBody: $('#cp-body'),
  cpLang: $('#cp-lang'),
  cpSub: $('#cp-sub'),
};

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const currentChat = () => conversations.find((c) => c.id === currentId) || null;

/* ------------------------------------------------------------------ */
/* Persistence                                                          */
/* ------------------------------------------------------------------ */

let saveTimer = null;
let stateLoaded = false;   // never persist before the load has completed

function snapshot() {
  // Private conversations are deliberately excluded: they exist only in memory.
  // Cached render output is stripped too, since it is derived data.
  return conversations.filter((c) => !c.private).map((c) => ({
    ...c,
    status: c.status === 'generating' ? 'done' : c.status,
    messages: c.messages.map((m) => ({
      id: m.id, role: m.role, model: m.model, content: m.content,
      thinking: m.thinking, stats: m.stats, error: m.error, tools: m.tools,
    })),
  }));
}

function writeNow() {
  if (!stateLoaded) return Promise.resolve();
  return Promise.all([
    window.api.storeSet('conversations.json', snapshot()),
    window.api.storeSet('settings.json', settings),
  ]);
}

function saveSoon() {
  // Saving before load would write an empty list over real history.
  if (!stateLoaded) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeNow, 400);
}

/* Write immediately, skipping the debounce. */
async function flushSave() {
  clearTimeout(saveTimer);
  await writeNow();
}

window.api.onFlush(async () => {
  await flushSave();
  window.api.flushed();
});

window.addEventListener('beforeunload', () => { flushSave(); });

async function loadState() {
  const s = await window.api.storeGet('settings.json');
  if (s) settings = { ...DEFAULT_SETTINGS, ...s };
  const c = await window.api.storeGet('conversations.json');
  conversations = Array.isArray(c) ? c : [];
  stateLoaded = true;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

function fmtBytes(n) {
  if (!n) return '';
  const gb = n / 1024 ** 3;
  return gb >= 1 ? gb.toFixed(1) + ' GB' : (n / 1024 ** 2).toFixed(0) + ' MB';
}

const EXT = {
  JavaScript: 'js', TypeScript: 'ts', Python: 'py', 'C#': 'cs', 'C++': 'cpp', C: 'c',
  Java: 'java', Go: 'go', Rust: 'rs', Ruby: 'rb', PHP: 'php', Shell: 'sh',
  PowerShell: 'ps1', SQL: 'sql', HTML: 'html', CSS: 'css', JSON: 'json',
  YAML: 'yaml', XML: 'xml', Markdown: 'md', Text: 'txt',
};

/* ------------------------------------------------------------------ */
/* Server + models                                                      */
/* ------------------------------------------------------------------ */

function setStatus(cls, text) {
  el.status.className = 'server-status ' + cls;
  el.status.querySelector('.txt').textContent = text;
}

async function initServer() {
  setStatus('', 'starting Ollama…');
  const r = await window.api.ensureServer();
  if (!r.running) {
    setStatus('bad', 'Ollama offline');
    showSystemError(
      'Could not reach Ollama on 127.0.0.1:11434.\n\n' + (r.error || '') +
      '\n\nStart it manually with "ollama serve", then reload with Ctrl+R.'
    );
    return false;
  }
  setStatus('ok', 'Ollama ' + (r.version || 'connected'));
  return true;
}

/* Short capability label shown next to each model in the picker. Judged against
   this machine: 3.3 GB usable VRAM, so anything much over ~3 GB spills to CPU. */
const MODEL_TRAITS = {
  'llama3.2:3b': 'fastest',
  'qwen2.5-coder:3b': 'fast · best at code',
  'phi4-mini:3.8b': 'fast · good at maths',
  'qwen3:4b': 'smart · slower, it reasons first',
  'gemma3:4b': 'smart · reads images',
  'qwen3:8b': 'smarter · partly on CPU',
  'gpt-oss:20b': 'smartest · slow, mostly CPU',
  'qwen3:30b-a3b': 'smartest · slow, mostly CPU',
};

function modelTrait(m) {
  const exact = MODEL_TRAITS[m.name];
  if (exact) return exact;
  if (/embed/i.test(m.name)) return 'embeddings only — not for chat';

  // Fall back to judging by file size against available VRAM.
  const gb = (m.size || 0) / 1024 ** 3;
  if (gb <= 2.2) return 'fastest';
  if (gb <= 3.2) return 'fast';
  if (gb <= 5) return 'smart · partly on CPU';
  return 'smartest · slow, mostly CPU';
}

async function refreshModels() {
  try { models = await window.api.listModels(); } catch { models = []; }

  el.modelSelect.innerHTML = '';
  if (!models.length) {
    const o = document.createElement('option');
    o.textContent = 'No models installed';
    o.value = '';
    el.modelSelect.appendChild(o);
    el.modelMeta.textContent = 'Open Models to download one';
    return;
  }
  for (const m of models) {
    const o = document.createElement('option');
    o.value = m.name;
    o.textContent = m.name + ' (' + modelTrait(m) + ')';
    el.modelSelect.appendChild(o);
  }
  const chat = currentChat();
  const want = (chat && chat.model) || settings.lastModel;
  el.modelSelect.value = models.find((m) => m.name === want) ? want : models[0].name;
  onModelChanged();
}

function onModelChanged() {
  const name = el.modelSelect.value;
  const m = models.find((x) => x.name === name);
  el.modelMeta.textContent = m ? [m.parameterSize, m.quantization, fmtBytes(m.size)].filter(Boolean).join(' · ') : '';
  settings.lastModel = name;
  const chat = currentChat();
  if (chat) chat.model = name;
  saveSoon();
}

/* ------------------------------------------------------------------ */
/* Conversation list                                                    */
/* ------------------------------------------------------------------ */

function renderChatList() {
  el.chatList.innerHTML = '';
  for (const c of conversations) {
    const row = document.createElement('div');
    row.className = 'chat-item' + (c.id === currentId ? ' active' : '');

    const dot = document.createElement('span');
    dot.className = 'st st-' + (c.status || 'idle');
    dot.title = {
      generating: 'Replying…', done: 'Finished', error: 'Failed', input: 'Waiting for you',
    }[c.status] || 'No activity yet';
    row.appendChild(dot);

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = c.title || 'New chat';
    title.title = 'Double-click to rename';
    title.addEventListener('dblclick', (e) => { e.stopPropagation(); beginRename(c.id); });
    row.appendChild(title);

    if (c.private) {
      const lock = document.createElement('span');
      lock.className = 'lock';
      lock.textContent = 'private';
      lock.title = 'Not saved to disk';
      row.appendChild(lock);
    }

    const del = document.createElement('button');
    del.className = 'del';
    del.type = 'button';
    del.textContent = '×';
    del.title = 'Delete conversation';
    del.addEventListener('click', (e) => { e.stopPropagation(); deleteChat(c.id); });
    row.appendChild(del);

    row.addEventListener('click', () => openChat(c.id));
    el.chatList.appendChild(row);
  }
}

function beginRename(id) {
  const chat = conversations.find((c) => c.id === id);
  if (!chat) return;
  const row = [...el.chatList.children].find((r, i) => conversations[i] && conversations[i].id === id);
  if (!row) return;
  const title = row.querySelector('.title');
  if (!title || row.querySelector('.rename-input')) return;

  const input = document.createElement('input');
  input.className = 'rename-input';
  input.type = 'text';
  input.value = chat.title || '';
  input.placeholder = 'Chat name';
  title.replaceWith(input);
  input.focus();
  input.select();

  let settled = false;
  const commit = (save) => {
    if (settled) return;
    settled = true;
    if (save) {
      chat.title = input.value.trim().slice(0, 80);
      chat.titleLocked = true;   // stop auto-naming from overwriting it
      saveSoon();
    }
    renderChatList();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') commit(true);
    if (e.key === 'Escape') commit(false);
  });
  input.addEventListener('blur', () => commit(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}

window.api.onRenameChat(() => { if (currentId) beginRename(currentId); });

function newChat() {
  const chat = {
    id: uid(), title: '',
    model: el.modelSelect.value || settings.lastModel || '',
    createdAt: new Date().toISOString(), messages: [],
    private: privateMode,
  };
  conversations.unshift(chat);
  currentId = chat.id;
  applyPrivateChrome(privateMode);
  renderChatList();
  renderMessages();
  clearCodePanel();
  saveSoon();
  el.input.focus();
}

function openChat(id) {
  currentId = id;
  const chat = currentChat();
  applyPrivateChrome(!!(chat && chat.private));
  if (chat && chat.model && models.find((m) => m.name === chat.model)) {
    el.modelSelect.value = chat.model;
    onModelChanged();
  }
  renderChatList();
  renderMessages();
  clearCodePanel();
  rebuildCodeIndex();
}

function deleteChat(id) {
  conversations = conversations.filter((c) => c.id !== id);
  if (currentId === id) {
    currentId = conversations.length ? conversations[0].id : null;
    if (!currentId) { newChat(); return; }
    openChat(currentId);
    return;
  }
  renderChatList();
  saveSoon();
}

/* ------------------------------------------------------------------ */
/* Message rendering                                                    */
/* ------------------------------------------------------------------ */

function renderMessages() {
  const chat = currentChat();
  el.messages.innerHTML = '';

  if (!chat || !chat.messages.length) {
    el.messages.appendChild(el.empty);
    el.empty.classList.remove('hidden');
    return;
  }
  el.empty.classList.add('hidden');
  for (const m of chat.messages) el.messages.appendChild(buildMessageNode(m));
  scrollToBottom(true);
}

function buildMessageNode(m) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + m.role + (m.error ? ' error' : '');
  wrap.dataset.mid = m.id;

  if (m.role === 'user') {
    const b = document.createElement('div');
    b.className = 'bubble';
    b.textContent = m.content;
    wrap.appendChild(b);
    return wrap;
  }

  const role = document.createElement('div');
  role.className = 'role';
  role.textContent = m.model || 'assistant';
  wrap.appendChild(role);

  if (Array.isArray(m.tools) && m.tools.length) wrap.appendChild(buildToolLog(m.tools));
  if (m.thinking && settings.showThinking) wrap.appendChild(buildThinkingNode(m.thinking, false));

  const content = document.createElement('div');
  content.className = 'content';
  if (m.error) {
    content.textContent = m.content;
  } else {
    const r = window.api.renderMessage(m.content || '');
    content.innerHTML = r.html;
    m._blocks = r.blocks;
    tagCards(content, m.id);
  }
  wrap.appendChild(content);

  if (m.stats && m.stats.tokens) {
    const s = document.createElement('div');
    s.className = 'stats';
    const parts = [m.stats.tokens + ' tokens', m.stats.tokensPerSecond.toFixed(1) + ' tok/s'];
    if (m.stats.loadSeconds > 0.5) parts.push(m.stats.loadSeconds.toFixed(1) + 's load');
    s.textContent = parts.join('  ·  ');
    wrap.appendChild(s);
  }
  return wrap;
}

function tagCards(contentNode, mid) {
  contentNode.querySelectorAll('.code-card').forEach((card) => {
    card.dataset.mid = mid;
  });
}

function buildToolLog(rows) {
  const box = document.createElement('div');
  box.className = 'tool-log';
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'tool-row';
    row.dataset.name = r.name;
    row.dataset.state = r.state;
    row.textContent = r.line;
    box.appendChild(row);
  }
  return box;
}

function buildThinkingNode(text, open) {
  const d = document.createElement('details');
  d.className = 'thinking';
  d.open = !!open;
  const sum = document.createElement('summary');
  sum.textContent = 'Reasoning';
  const body = document.createElement('div');
  body.className = 'think-body';
  body.textContent = text;
  d.append(sum, body);
  return d;
}

function showSystemError(text) {
  el.empty.classList.add('hidden');
  el.messages.appendChild(buildMessageNode({ id: uid(), role: 'assistant', content: text, error: true }));
  scrollToBottom(true);
}

let pinnedToBottom = true;
el.messages.addEventListener('scroll', () => {
  pinnedToBottom = el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 90;
});
function scrollToBottom(force) {
  if (force || pinnedToBottom) el.messages.scrollTop = el.messages.scrollHeight;
}

/* ------------------------------------------------------------------ */
/* Code panel                                                           */
/* ------------------------------------------------------------------ */

let codeIndex = [];   // [{key, mid, idx, lang, code, lines}]
let activeCodeKey = null;

function blocksForMessage(m) {
  if (!m._blocks) m._blocks = window.api.renderMessage(m.content || '').blocks;
  return m._blocks;
}

function rebuildCodeIndex() {
  const chat = currentChat();
  codeIndex = [];
  if (!chat) return renderCodeTabs();
  for (const m of chat.messages) {
    if (m.role !== 'assistant' || m.error || !m.content) continue;
    for (const b of blocksForMessage(m)) {
      codeIndex.push({ key: m.id + ':' + b.index, mid: m.id, idx: b.index, lang: b.lang, code: b.code, lines: b.lines });
    }
  }
  renderCodeTabs();
}

function renderCodeTabs() {
  el.cpTabs.innerHTML = '';
  codeIndex.forEach((b, i) => {
    const t = document.createElement('button');
    t.type = 'button';
    t.className = 'cp-tab' + (b.key === activeCodeKey ? ' active' : '');
    t.textContent = window.api.prettyLang(b.lang) + ' ' + (i + 1);
    t.addEventListener('click', () => showCode(b.key));
    el.cpTabs.appendChild(t);
  });
}

function openPanel() {
  el.panel.classList.remove('collapsed');
  $('#toggle-code').classList.add('active');
}
function closePanel() {
  el.panel.classList.add('collapsed');
  $('#toggle-code').classList.remove('active');
}
function clearCodePanel() {
  activeCodeKey = null;
  codeIndex = [];
  el.cpTabs.innerHTML = '';
  el.cpBody.innerHTML = '<div class="cp-empty">Code from the conversation shows up here.</div>';
  el.cpLang.textContent = 'Code';
  el.cpSub.textContent = '';
}

function showCode(key) {
  const b = codeIndex.find((x) => x.key === key);
  if (!b) return;
  activeCodeKey = key;
  el.cpLang.textContent = window.api.prettyLang(b.lang);
  el.cpSub.textContent = b.lines + (b.lines === 1 ? ' line' : ' lines');
  el.cpBody.innerHTML = window.api.highlightBlock(b.code, b.lang);
  el.cpBody.scrollTop = 0;
  renderCodeTabs();
  openPanel();

  document.querySelectorAll('.code-card').forEach((c) => {
    c.classList.toggle('active', c.dataset.mid === b.mid && c.dataset.idx === String(b.idx));
  });
}

/* clicking a code card in the chat opens it in the panel */
el.messages.addEventListener('click', (e) => {
  const card = e.target.closest('.code-card');
  if (!card) return;
  rebuildCodeIndex();
  showCode(card.dataset.mid + ':' + card.dataset.idx);
});

$('#toggle-code').addEventListener('click', () => {
  if (el.panel.classList.contains('collapsed')) {
    rebuildCodeIndex();
    if (codeIndex.length && !activeCodeKey) showCode(codeIndex[codeIndex.length - 1].key);
    else openPanel();
  } else {
    closePanel();
  }
});
$('#cp-close').addEventListener('click', closePanel);

$('#cp-copy').addEventListener('click', () => {
  const b = codeIndex.find((x) => x.key === activeCodeKey);
  if (!b) return;
  navigator.clipboard.writeText(b.code).then(() => {
    const btn = $('#cp-copy');
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1400);
  });
});

$('#cp-save').addEventListener('click', async () => {
  const b = codeIndex.find((x) => x.key === activeCodeKey);
  if (!b) return;
  const ext = EXT[window.api.prettyLang(b.lang)] || 'txt';
  await window.api.saveFile('snippet.' + ext, b.code);
});

/* resizable panel */
(function makeResizable() {
  const drag = $('#cp-drag');
  let startX = 0, startW = 0, dragging = false;
  drag.addEventListener('mousedown', (e) => {
    dragging = true;
    startX = e.clientX;
    startW = el.panel.getBoundingClientRect().width;
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const w = Math.min(Math.max(startW + (startX - e.clientX), 320), window.innerWidth - 520);
    el.panel.style.width = w + 'px';
    el.panel.style.flexBasis = w + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    settings.codePanelWidth = el.panel.getBoundingClientRect().width;
    saveSoon();
  });
})();

/* ------------------------------------------------------------------ */
/* Private mode                                                         */
/* ------------------------------------------------------------------ */

function applyPrivateChrome(on) {
  document.body.classList.toggle('private-mode', on);
  $('#toggle-private').classList.toggle('active', on);
  $('#private-banner').classList.toggle('hidden', !on);
  $('#export-chat').disabled = on;
  $('#export-chat').title = on
    ? 'Export is disabled in a private chat'
    : 'Export this conversation as Markdown';
}

$('#toggle-private').addEventListener('click', () => {
  privateMode = !privateMode;
  applyPrivateChrome(privateMode);
  // Start a fresh conversation so the mode applies cleanly from the first turn.
  newChat();
});

/* ------------------------------------------------------------------ */
/* Sending                                                              */
/* ------------------------------------------------------------------ */

function setGenerating(on) {
  el.send.classList.toggle('hidden', on);
  el.stop.classList.toggle('hidden', !on);
  el.modelSelect.disabled = on;
}

async function sendMessage() {
  const text = el.input.value.trim();
  if (!text || activeRequestId) return;

  const model = el.modelSelect.value;
  if (!model) {
    showSystemError('No model selected. Open Models and download one first — qwen3:4b is a good starting point.');
    return;
  }

  if (!currentChat()) newChat();
  const chat = currentChat();
  chat.model = model;

  const userMsg = { id: uid(), role: 'user', content: text };
  chat.messages.push(userMsg);
  if (!chat.title && !chat.titleLocked) {
    chat.title = text.slice(0, 48).replace(/\s+/g, ' ').trim();
  }

  el.input.value = '';
  autoGrow();
  el.empty.classList.add('hidden');
  el.messages.appendChild(buildMessageNode(userMsg));
  pinnedToBottom = true;
  scrollToBottom(true);

  const aMsg = { id: uid(), role: 'assistant', model, content: '', thinking: '', stats: null };
  chat.messages.push(aMsg);
  const node = buildMessageNode(aMsg);
  node.classList.add('streaming');
  el.messages.appendChild(node);
  scrollToBottom(true);

  const payload = {
    requestId: uid(),
    model,
    messages: buildApiMessages(chat, aMsg),
    browserTools: true,
    options: {
      temperature: settings.temperature,
      numCtx: settings.numCtx,
      numThread: settings.numThread || undefined,
      numGpu: settings.numGpu >= 0 ? settings.numGpu : undefined,
    },
  };

  if (attachedPage) { attachedPage = null; renderPageChip(); }

  activeRequestId = payload.requestId;
  chat.status = 'generating';
  renderChatList();
  setGenerating(true);
  // Hold the chat OBJECT, never the id — the current selection may move while
  // a reply is still streaming.
  streamTargets.set(payload.requestId, { msg: aMsg, node, chat });
  await window.api.send(payload);
}

function buildApiMessages(chat, exclude) {
  const out = [];
  if (settings.systemPrompt.trim()) out.push({ role: 'system', content: settings.systemPrompt.trim() });
  out.push({
    role: 'system',
    content: 'You can control the user\'s Chrome browser through tools. To open or visit a '
      + 'website, call open_page with the URL. Use read_current_page to read what they are '
      + 'looking at, list_tabs to see what is open, and collect_pages for anything paginated '
      + '(call it once with max_pages set instead of manually chaining open_page/click_on/'
      + 'extract_links yourself). Never say you are unable to browse — call the tool, and '
      + 'report whatever it returns.\n\n'
      + 'Never claim a page was opened, clicked, or a file was saved unless you actually called '
      + 'that tool IN THIS RESPONSE and are reporting its real result. Do not guess a file '
      + 'location such as "Downloads" — the tool result always states the exact path; quote it '
      + 'exactly, never approximate it from memory.\n\n'
      + 'Once a tool result confirms the user\'s request is complete (a file was saved, a page was '
      + 'read, an answer was found), STOP: give one short confirmation sentence and end your turn. '
      + 'Do not keep reasoning, re-checking, or calling more tools after the task is already done.',
  });
  if (attachedPage) {
    out.push({
      role: 'system',
      content: 'The user is looking at this web page. Answer using it when relevant.\n\n'
        + 'Title: ' + attachedPage.title + '\nURL: ' + attachedPage.url
        + '\n\n--- page text ---\n' + attachedPage.text,
    });
  }
  for (const m of chat.messages) {
    if (m === exclude || m.error || !m.content) continue;
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Streaming                                                            */
/* ------------------------------------------------------------------ */

const streamTargets = new Map();
let rafPending = false;
const dirty = new Set();

function markDirty(id) {
  dirty.add(id);
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    const ids = [...dirty];
    dirty.clear();
    for (const i of ids) {
      try { paint(i); } catch (err) { console.error('paint failed', err); }
    }
  });
}

function paint(requestId) {
  const t = streamTargets.get(requestId);
  if (!t) return;
  const { msg, node } = t;

  if (msg.thinking && settings.showThinking) {
    let think = node.querySelector('.thinking');
    if (!think) {
      think = buildThinkingNode(msg.thinking, true);
      node.insertBefore(think, node.querySelector('.content'));
    } else {
      think.querySelector('.think-body').textContent = msg.thinking;
    }
  }

  const content = node.querySelector('.content');
  if (!content) return;
  const r = window.api.renderMessage(msg.content);
  content.innerHTML = r.html;
  msg._blocks = r.blocks;
  tagCards(content, msg.id);
  scrollToBottom(false);
}

window.api.onChunk(({ requestId, content, thinking }) => {
  const t = streamTargets.get(requestId);
  if (!t) return;
  if (content) t.msg.content += content;
  if (thinking) t.msg.thinking += thinking;
  markDirty(requestId);
});

window.api.onReclassify(({ requestId, thinking, content }) => {
  const t = streamTargets.get(requestId);
  if (!t) return;
  t.msg.thinking = (t.msg.thinking ? t.msg.thinking + '\n' : '') + thinking;
  t.msg.content = content;
  markDirty(requestId);
});

// The model sometimes writes a tool call as plain text instead of a real tool
// invocation; when the app recovers and runs it anyway, this drops the raw
// JSON that already streamed into the bubble so a tool row appears instead.
window.api.onTrimContent(({ requestId, chars }) => {
  const t = streamTargets.get(requestId);
  if (!t || !chars) return;
  t.msg.content = t.msg.content.slice(0, Math.max(0, t.msg.content.length - chars));
  markDirty(requestId);
});

function finishStream(requestId, mutate) {
  const t = streamTargets.get(requestId);
  if (t) {
    mutate(t);
    t.chat.status = t.msg.error ? 'error' : 'done';
    streamTargets.delete(requestId);
    t.node.classList.remove('streaming');
    const fresh = buildMessageNode(t.msg);
    if (t.node.isConnected) t.node.replaceWith(fresh);

    if (t.chat.id === currentId) {
      rebuildCodeIndex();
      const mine = codeIndex.filter((b) => b.mid === t.msg.id);
      if (mine.length) showCode(mine[0].key);
      scrollToBottom(false);
    }
    renderChatList();
  }
  if (requestId === activeRequestId) {
    activeRequestId = null;
    setGenerating(false);
  }
  flushSave();   // a completed reply is written at once, not on a timer
}

window.api.onToolEvent(({ requestId, name, detail, state }) => {
  const t = streamTargets.get(requestId);
  if (!t) return;
  const label = {
    open_page: 'Opening', read_current_page: 'Reading the current page', list_tabs: 'Listing tabs',
  }[name] || name;
  const line = state === 'error'
    ? 'Browser error: ' + detail
    : label + (detail ? ' ' + detail : '') + (state === 'running' ? '…' : ' ✓');

  // Kept on the message itself so it survives the rebuild at the end of the stream.
  if (!t.msg.tools) t.msg.tools = [];
  const rows = t.msg.tools;
  const last = rows[rows.length - 1];
  if (last && state !== 'running' && last.name === name) {
    last.line = line;
    last.state = state;
  } else {
    rows.push({ name, state, line });
  }

  const existing = t.node.querySelector('.tool-log');
  const fresh = buildToolLog(rows);
  if (existing) existing.replaceWith(fresh);
  else t.node.insertBefore(fresh, t.node.querySelector('.content'));
  scrollToBottom(false);
});

window.api.onDone(({ requestId, stats, cancelled }) => {
  finishStream(requestId, (t) => {
    if (stats) t.msg.stats = stats;
    if (cancelled && !t.msg.content) t.msg.content = '_(stopped)_';
  });
  el.input.focus();
});

window.api.onError(({ requestId, error }) => {
  finishStream(requestId, (t) => {
    t.msg.error = true;
    t.msg.content = 'Error: ' + error;
  });
});

/* ------------------------------------------------------------------ */
/* Composer + chrome                                                    */
/* ------------------------------------------------------------------ */

function autoGrow() {
  el.input.style.height = 'auto';
  el.input.style.height = Math.min(el.input.scrollHeight, 220) + 'px';
}
el.input.addEventListener('input', autoGrow);
el.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); }
});
el.send.addEventListener('click', sendMessage);
el.stop.addEventListener('click', () => { if (activeRequestId) window.api.abort(activeRequestId); });

document.querySelectorAll('.suggest').forEach((b) => {
  b.addEventListener('click', () => {
    const raw = b.dataset.p.replace(/@@/g, '\n\n');
    el.input.value = raw;
    autoGrow();
    el.input.focus();
    if (!raw.endsWith('\n')) sendMessage();
  });
});

$('#new-chat').addEventListener('click', newChat);
el.modelSelect.addEventListener('change', onModelChanged);
window.api.onNewChat(newChat);
$('#clear-chat').addEventListener('click', () => { if (currentId) deleteChat(currentId); });

$('#export-chat').addEventListener('click', async () => {
  const chat = currentChat();
  if (!chat || !chat.messages.length || chat.private) return;
  const lines = ['# ' + (chat.title || 'Conversation'), '', '_Model: ' + (chat.model || '?') + '_', ''];
  for (const m of chat.messages) {
    lines.push(m.role === 'user' ? '## You' : '## ' + (m.model || 'Assistant'), '', m.content, '');
  }
  const safe = (chat.title || 'conversation').replace(/[^\w\- ]+/g, '').slice(0, 40) || 'conversation';
  await window.api.exportChat(safe + '.md', lines.join('\n'));
});

/* ------------------------------------------------------------------ */
/* Modals                                                               */
/* ------------------------------------------------------------------ */

const openModal = (id) => $('#' + id).classList.remove('hidden');
const closeModal = (id) => $('#' + id).classList.add('hidden');

document.querySelectorAll('.modal-close').forEach((b) => b.addEventListener('click', () => closeModal(b.dataset.close)));
document.querySelectorAll('.modal').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) m.classList.add('hidden'); }));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.querySelectorAll('.modal').forEach((m) => m.classList.add('hidden'));
});

function ctxHint(v) {
  return v <= 2048
    ? 'Fits alongside a 4B model inside your 3.3 GB of VRAM — fastest setting.'
    : 'Above 2048 the model starts spilling into system RAM on this GPU, which slows generation noticeably.';
}

$('#open-settings').addEventListener('click', async () => {
  $('#system-prompt').value = settings.systemPrompt;
  $('#temperature').value = settings.temperature;
  $('#temp-val').textContent = Number(settings.temperature).toFixed(2);
  $('#num-ctx').value = settings.numCtx;
  $('#ctx-val').textContent = settings.numCtx;
  $('#ctx-hint').textContent = ctxHint(settings.numCtx);
  $('#show-thinking').checked = settings.showThinking;
  const p = await window.api.paths();
  $('#paths-info').textContent = 'Chats:  ' + p.userData + '\nModels: ' + p.models;
  refreshExtUi();
  openModal('settings-modal');
});

$('#system-prompt').addEventListener('input', (e) => { settings.systemPrompt = e.target.value; saveSoon(); });
$('#temperature').addEventListener('input', (e) => {
  settings.temperature = parseFloat(e.target.value);
  $('#temp-val').textContent = settings.temperature.toFixed(2);
  saveSoon();
});
$('#num-ctx').addEventListener('input', (e) => {
  settings.numCtx = parseInt(e.target.value, 10);
  $('#ctx-val').textContent = settings.numCtx;
  $('#ctx-hint').textContent = ctxHint(settings.numCtx);
  saveSoon();
});
$('#show-thinking').addEventListener('change', (e) => {
  settings.showThinking = e.target.checked;
  saveSoon();
  renderMessages();
});

/* ------------------------------------------------------------------ */
/* Models modal                                                         */
/* ------------------------------------------------------------------ */

const RECOMMENDED = [
  { name: 'qwen3:4b', size: '2.6 GB', desc: 'Best all-rounder that fits fully in VRAM. Reasons before answering.', tier: 'gpu' },
  { name: 'llama3.2:3b', size: '2.0 GB', desc: 'Fastest good chat model — answers immediately, no reasoning pause.', tier: 'gpu' },
  { name: 'qwen2.5-coder:3b', size: '1.9 GB', desc: 'Tuned for writing and explaining code.', tier: 'gpu' },
  { name: 'gemma3:4b', size: '3.3 GB', desc: 'Google Gemma 3. Strong writing, and can read images.', tier: 'gpu' },
  { name: 'phi4-mini:3.8b', size: '2.5 GB', desc: 'Microsoft Phi-4 mini. Punches above its weight on maths and logic.', tier: 'gpu' },
  { name: 'gpt-oss:20b', size: '13 GB', desc: "OpenAI's open-weight GPT. Strongest reasoning you can run here.", tier: 'cpu' },
  { name: 'qwen3:30b-a3b', size: '18 GB', desc: 'Mixture-of-experts: 30B total but only 3B active, so it stays usable on CPU.', tier: 'cpu' },
];

function renderModelsModal() {
  const installed = new Set(models.map((m) => m.name));

  const rec = $('#rec-list');
  rec.innerHTML = '';
  for (const r of RECOMMENDED) {
    const row = document.createElement('div');
    row.className = 'model-row';

    const info = document.createElement('div');
    info.className = 'info';
    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.textContent = r.name;
    const ds = document.createElement('div');
    ds.className = 'ds';
    ds.textContent = r.size + ' — ' + r.desc;
    const sp = document.createElement('div');
    sp.className = 'speed' + (r.tier === 'gpu' ? '' : ' slow');
    sp.textContent = r.tier === 'gpu' ? 'Runs on the GPU — fast' : 'Runs mostly on CPU — slow but much smarter';
    info.append(nm, ds, sp);
    row.appendChild(info);

    if (installed.has(r.name)) {
      const tag = document.createElement('span');
      tag.className = 'installed-tag';
      tag.textContent = 'Installed';
      row.appendChild(tag);
    } else {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Download';
      btn.addEventListener('click', () => startPull(r.name));
      row.appendChild(btn);
    }
    rec.appendChild(row);
  }

  const inst = $('#installed-list');
  inst.innerHTML = '';
  if (!models.length) {
    const d = document.createElement('div');
    d.className = 'ds';
    d.textContent = 'Nothing installed yet.';
    inst.appendChild(d);
    return;
  }
  for (const m of models) {
    const row = document.createElement('div');
    row.className = 'model-row';
    const info = document.createElement('div');
    info.className = 'info';
    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.textContent = m.name;
    const ds = document.createElement('div');
    ds.className = 'ds';
    ds.textContent = [m.parameterSize, m.quantization, fmtBytes(m.size)].filter(Boolean).join(' · ');
    info.append(nm, ds);
    row.appendChild(info);

    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'rm';
    rm.textContent = 'Remove';
    rm.addEventListener('click', async () => {
      rm.disabled = true;
      try {
        await window.api.deleteModel(m.name);
        await refreshModels();
        renderModelsModal();
      } catch { rm.textContent = 'Failed'; }
    });
    row.appendChild(rm);
    inst.appendChild(row);
  }
}

let pullId = null;

function startPull(name) {
  if (pullId) return;
  pullId = uid();
  $('#pull-status').classList.remove('hidden');
  $('#pull-bar').style.width = '0%';
  $('#pull-text').textContent = 'Starting ' + name + '…';
  $('#pull-btn').disabled = true;
  window.api.pullModel(name, pullId).catch(() => {});
}

window.api.onPullProgress(({ requestId, status, completed, total }) => {
  if (requestId !== pullId) return;
  const pct = total > 0 ? (completed / total) * 100 : 0;
  $('#pull-bar').style.width = pct.toFixed(1) + '%';
  $('#pull-text').textContent = total > 0
    ? status + ' — ' + fmtBytes(completed) + ' / ' + fmtBytes(total) + '  (' + pct.toFixed(0) + '%)'
    : status;
});

window.api.onPullDone(async ({ requestId, error, cancelled }) => {
  if (requestId !== pullId) return;
  pullId = null;
  $('#pull-btn').disabled = false;
  if (error) $('#pull-text').textContent = 'Failed: ' + error;
  else if (cancelled) $('#pull-text').textContent = 'Cancelled.';
  else {
    $('#pull-bar').style.width = '100%';
    $('#pull-text').textContent = 'Done.';
    setTimeout(() => $('#pull-status').classList.add('hidden'), 2500);
  }
  await refreshModels();
  renderModelsModal();
});

$('#open-models').addEventListener('click', async () => {
  await refreshModels();
  renderModelsModal();
  openModal('models-modal');
});
$('#pull-btn').addEventListener('click', () => {
  const n = $('#pull-name').value.trim();
  if (n) startPull(n);
});
$('#pull-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#pull-btn').click(); });

/* ------------------------------------------------------------------ */
/* Performance panel                                                    */
/* ------------------------------------------------------------------ */

let benchId = null;
const benchRows = new Map();

function speedClass(tps) {
  if (tps >= 15) return 'fast';
  if (tps >= 6) return 'mid';
  return 'slow';
}

function benchRow(model) {
  let row = benchRows.get(model);
  if (row) return row;
  row = document.createElement('div');
  row.className = 'bench-row pending';
  const nm = document.createElement('div');
  nm.className = 'nm';
  nm.textContent = model;
  const sp = document.createElement('div');
  sp.className = 'sp';
  sp.textContent = 'queued';
  const where = document.createElement('div');
  where.className = 'where';
  row.append(nm, sp, where);
  $('#bench-results').appendChild(row);
  benchRows.set(model, row);
  return row;
}

window.api.onBenchProgress(({ requestId, model, state, result }) => {
  if (requestId !== benchId) return;
  const row = benchRow(model);
  const sp = row.querySelector('.sp');
  const where = row.querySelector('.where');

  if (state === 'running') {
    row.className = 'bench-row pending';
    sp.textContent = 'measuring…';
    return;
  }
  if (state === 'error') {
    row.className = 'bench-row slow';
    sp.textContent = 'failed';
    where.textContent = (result && result.error ? result.error : '').slice(0, 40);
    return;
  }
  const tps = result.tokensPerSecond || 0;
  row.className = 'bench-row ' + speedClass(tps);
  sp.textContent = tps.toFixed(1) + ' tok/s';
  const pct = Math.round((result.gpuFraction || 0) * 100);
  where.textContent = result.sizeTotal
    ? pct + '% on GPU' + (result.loadSeconds > 1 ? ' · ' + result.loadSeconds.toFixed(0) + 's load' : '')
    : '';
});

$('#open-perf').addEventListener('click', async () => {
  const info = await window.api.sysInfo();
  $('#sys-info').textContent = [
    info.cpuModel,
    info.logicalCores + ' logical cores · ' + info.totalMemGb.toFixed(0) + ' GB RAM (' +
      info.freeMemGb.toFixed(0) + ' GB free)',
  ].join('\n');

  $('#num-thread').value = settings.numThread;
  $('#thread-val').textContent = settings.numThread ? String(settings.numThread) : 'auto';
  $('#num-gpu').value = settings.numGpu;
  $('#gpu-val').textContent = settings.numGpu >= 0 ? String(settings.numGpu) : 'auto';
  openModal('perf-modal');
});

$('#num-thread').addEventListener('input', (e) => {
  settings.numThread = parseInt(e.target.value, 10);
  $('#thread-val').textContent = settings.numThread ? String(settings.numThread) : 'auto';
  saveSoon();
});
$('#num-gpu').addEventListener('input', (e) => {
  settings.numGpu = parseInt(e.target.value, 10);
  $('#gpu-val').textContent = settings.numGpu >= 0 ? String(settings.numGpu) : 'auto';
  saveSoon();
});

$('#bench-btn').addEventListener('click', async () => {
  if (benchId) return;
  await refreshModels();
  // Embedding models cannot answer a chat prompt — leave them out.
  const targets = models.map((m) => m.name).filter((n) => !/embed/i.test(n));
  if (!targets.length) return;

  benchId = uid();
  benchRows.clear();
  $('#bench-results').innerHTML = '';
  targets.forEach(benchRow);
  $('#bench-btn').disabled = true;
  $('#bench-btn').textContent = 'Benchmarking…';

  try {
    await window.api.benchmark(targets, {
      num_thread: settings.numThread || undefined,
      num_gpu: settings.numGpu >= 0 ? settings.numGpu : undefined,
    }, benchId);
  } finally {
    benchId = null;
    $('#bench-btn').disabled = false;
    $('#bench-btn').textContent = 'Benchmark installed models';
  }
});

/* ------------------------------------------------------------------ */
/* Browser link (Chrome extension)                                      */
/* ------------------------------------------------------------------ */

let browserConnected = false;   // tools are always offered; this only drives the UI
let attachedPage = null;        // { title, url, text } pulled from the linked tab

function setExtStatus(cls, text) {
  const el2 = $('#ext-status');
  if (!el2) return;
  el2.className = 'server-status ' + cls;
  el2.querySelector('.txt').textContent = text;
}

async function refreshExtUi() {
  const st = await window.api.extStatus();
  browserConnected = !!st.connected;
  if (st.connected) {
    setExtStatus('ok', 'linked');
    $('#attach-page').classList.remove('hidden');
  } else {
    setExtStatus('bad', 'not linked');
    $('#attach-page').classList.add('hidden');
  }
}

$('#ext-open-folder').addEventListener('click', () => window.api.openExtensionFolder());
$('#ext-reconnect').addEventListener('click', async () => {
  const btn = $('#ext-reconnect');
  btn.disabled = true;
  setExtStatus('', 'checking…');
  await refreshExtUi();
  btn.disabled = false;
});
$('#ext-open-chrome-extensions').addEventListener('click', () => window.api.openExternal('chrome://extensions'));

function renderPageChip() {
  const existing = $('#page-chip');
  if (existing) existing.remove();
  if (!attachedPage) {
    $('#attach-page').classList.remove('armed');
    return;
  }
  const chip = document.createElement('div');
  chip.className = 'page-chip';
  chip.id = 'page-chip';

  const t = document.createElement('span');
  t.className = 'pc-title';
  t.textContent = attachedPage.title + '  \u2014  ' + attachedPage.url;
  t.title = attachedPage.url;

  const n = document.createElement('span');
  n.textContent = Math.round(attachedPage.text.length / 1000) + 'k chars';

  const x = document.createElement('button');
  x.type = 'button';
  x.textContent = '\u00d7';
  x.title = 'Remove this page';
  x.addEventListener('click', () => { attachedPage = null; renderPageChip(); });

  chip.append(t, n, x);
  $('#composer-wrap').insertBefore(chip, $('#composer'));
  $('#attach-page').classList.add('armed');
}

$('#attach-page').addEventListener('click', async () => {
  if (attachedPage) { attachedPage = null; renderPageChip(); return; }
  const btn = $('#attach-page');
  btn.disabled = true;
  const r = await window.api.extReadTab();
  btn.disabled = false;
  if (!r.ok) { showSystemError('Could not read the linked browser: ' + r.error); return; }
  attachedPage = r.page;
  renderPageChip();
  el.input.focus();
});

/* ------------------------------------------------------------------ */
/* Video generation                                                     */
/* ------------------------------------------------------------------ */

/* Sampling settings are fixed to the values in ComfyUI's official WAN
   templates. Lower step counts under-denoise badly: at 12 steps the output is
   coloured noise, at 30 it resolves into a real scene. */
const STANDARD_STEPS = 30;

const VIDEO_DEFAULTS = {
  checkpoint: 'ltx-video-2b-v0.9.5.safetensors',
  textEncoder: 't5xxl_fp8_e4m3fn.safetensors',
  fps: 24,
  cfg: 3.0,
};

let videoJobId = null;
let referenceImagePath = null;   // reference photo for image-to-video

function setMode(mode) {
  const chat = mode !== 'video';
  $('#main').classList.toggle('hidden', !chat);
  $('#video-main').classList.toggle('hidden', chat);
  $('#new-chat').classList.toggle('hidden', !chat);
  el.chatList.classList.toggle('hidden', !chat);
  if (!chat) closePanel();
  document.querySelectorAll('.mode-tab').forEach((t) => {
    t.classList.toggle('active', (t.dataset.mode === 'video') === !chat);
  });
  if (!chat) {
    refreshEngineStatus();
    refreshEngineList();
    syncFastModeAvailability();
    refreshVideoDir();
    refreshGallery();
  }
}

document.querySelectorAll('.mode-tab').forEach((t) => {
  t.addEventListener('click', () => setMode(t.dataset.mode));
});

function setReferenceImage(p) {
  referenceImagePath = p;
  $('#v-image').value = p || '';
  updateEstimate();
}

$('#v-image-pick').addEventListener('click', async () => {
  const r = await window.api.pickImage();
  if (r.cancelled) return;
  setReferenceImage(r.path);
});
$('#v-image-clear').addEventListener('click', () => setReferenceImage(null));
$('#v-engine').addEventListener('change', () => { syncFastModeAvailability(); updateEstimate(); });

/* WAN 2.1 has no image-to-video weights here, so the field only applies to 2.2. */
async function syncFastModeAvailability() {
  const sel = $('#v-quality');
  if (!sel) return;
  const engine = $('#v-engine').value;
  const have = await window.api.hasFastMode();
  const usable = have && engine === 'wan';
  sel.disabled = !usable;
  if (!usable) sel.value = 'best';
  sel.title = usable
    ? 'Fast mode uses a step-distillation LoRA'
    : 'Fast mode needs the CausVid LoRA and only applies to WAN 2.1';
}

function syncImageFieldAvailability() {
  const engine = $('#v-engine') ? $('#v-engine').value : 'wan22';
  const supports = engine === 'wan22';
  $('#v-image-row').style.opacity = supports ? '' : '.45';
  $('#v-image-pick').disabled = !supports;
  $('#v-image-clear').disabled = !supports;
  $('#v-image').placeholder = supports
    ? 'No photo chosen — the video will be generated from text alone'
    : 'WAN 2.1 is text-only. Switch to WAN 2.2 to use a photo.';
}

function videoParams() {
  const [width, height] = $('#v-size').value.split('x').map(Number);
  const engine = $('#v-engine') ? $('#v-engine').value : 'wan22';
  return {
    ...VIDEO_DEFAULTS,
    engine,
    fps: engine === 'wan' ? 16 : 24,
    imagePath: referenceImagePath || null,
    width,
    height,
    length: parseInt($('#v-length').value, 10),
    quality: $('#v-quality') ? $('#v-quality').value : 'fast',
    steps: STANDARD_STEPS,
    seed: Math.floor(Math.random() * 2147483647),
    prompt: $('#v-prompt').value.trim(),
    negative: $('#v-negative').value.trim(),
  };
}

/* Cost model calibrated on this machine (Quadro P2000, 320x192, 25 frames,
   12 steps): WAN 2.2 took 178-226s, WAN 2.1 took 199s warm. Both work out to
   roughly 27 seconds per step at the reference scale below. */
const REF_PIXELS = 384 * 256;
const REF_FRAMES = 41;
// Measured again through the app (cold start, image-to-video): 324s for
// 320x192 / 25 frames / 10 steps. Erring pessimistic beats promising too much.
const SECONDS_PER_STEP = { wan22: 55, wan: 58 };

function estimateSeconds(p) {
  const scale = (p.width * p.height) / REF_PIXELS * (p.length / REF_FRAMES);
  const perStep = SECONDS_PER_STEP[p.engine] || 55;
  // WAN 2.2 has no distillation LoRA available, so it always runs the full 30.
  const effectiveSteps = (p.quality === 'fast' && p.engine === 'wan') ? 10 : 30;
  const loadOverhead = 70 + 25 * scale;
  return perStep * scale * effectiveSteps + loadOverhead;
}

function updateEstimate() {
  syncImageFieldAvailability();
  const p = videoParams();
  const secs = p.length / p.fps;
  $('#v-len-val').textContent = secs.toFixed(1) + 's';

  const est = estimateSeconds(p);
  const mins = est / 60;
  const mode = (p.engine === 'wan22' && p.imagePath) ? 'Animating your photo' : 'Generating from text';
  $('#v-estimate').textContent =
    mode + ' — ' + p.width + '×' + p.height + ', ' + p.length + ' frames (' + secs.toFixed(1) +
    's at ' + p.fps + 'fps). Estimated ' +
    (mins < 1 ? Math.round(est) + ' seconds' : mins.toFixed(1) + ' minutes') +
    ' on your Quadro P2000. The first run of a session adds a couple of minutes while the models load.';
}

['#v-engine', '#v-quality', '#v-size', '#v-length'].forEach((sel) => {
  $(sel).addEventListener('input', updateEstimate);
  $(sel).addEventListener('change', updateEstimate);
});

async function refreshEngineList() {
  const sel = $('#v-engine');
  if (!sel) return;
  const have = await window.api.comfyEngines();
  for (const opt of sel.options) {
    const ok = have[opt.value];
    opt.disabled = !ok;
    const base = opt.textContent.replace(/ \u2014 not downloaded$/, '');
    opt.textContent = ok ? base : base + ' \u2014 not downloaded';
  }
  if (sel.selectedOptions[0] && sel.selectedOptions[0].disabled) {
    const first = [...sel.options].find((o) => !o.disabled);
    if (first) sel.value = first.value;
  }
}

async function refreshEngineStatus() {
  const st = $('#engine-status');
  const txt = st.querySelector('.txt');
  const s = await window.api.comfyStatus();
  if (s.running) {
    st.className = 'server-status ok';
    txt.textContent = (s.device || 'GPU') + ' ready';
    $('#engine-start').classList.add('hidden');
  } else if (s.installed) {
    st.className = 'server-status bad';
    txt.textContent = 'engine stopped';
    $('#engine-start').classList.remove('hidden');
    $('#engine-start').textContent = 'Start engine';
  } else {
    st.className = 'server-status bad';
    txt.textContent = 'ComfyUI not installed';
    $('#engine-start').classList.add('hidden');
  }
  return s.running;
}

$('#engine-start').addEventListener('click', async () => {
  const b = $('#engine-start');
  b.disabled = true;
  b.textContent = 'Starting… (up to 2 min)';
  const r = await window.api.comfyStart();
  b.disabled = false;
  if (!r.running) showVideoError(r.error || 'Could not start the engine.');
  await refreshEngineStatus();
});

function showVideoError(msg) {
  const e = $('#v-error');
  e.textContent = msg;
  e.classList.remove('hidden');
}

async function refreshVideoDir() {
  const info = await window.api.getVideoDir();
  $('#v-dir').value = info.dir;
  $('#v-dir-note').textContent = info.writable
    ? (info.isDefault ? 'Default location. Click Change to pick your own folder.' : 'Custom location.')
    : 'This folder is not writable — pick another one.';
  $('#v-dir-note').style.color = info.writable ? '' : 'var(--danger)';
}

$('#v-dir-change').addEventListener('click', async () => {
  const r = await window.api.chooseVideoDir();
  if (r.cancelled) return;
  await refreshVideoDir();
  await refreshGallery();
});
$('#v-dir-open').addEventListener('click', () => window.api.openVideoDir());

async function refreshGallery() {
  const g = $('#v-gallery');
  if (!g) return;   // gallery section is not part of the UI
  const items = await window.api.listVideos();
  g.innerHTML = '';
  if (!items.length) {
    const d = document.createElement('div');
    d.className = 'v-empty';
    d.textContent = 'Nothing generated yet.';
    g.appendChild(d);
    return;
  }
  for (const it of items) {
    const card = document.createElement('div');
    card.className = 'v-card';

    const vid = document.createElement('video');
    vid.src = 'hgptmedia://local/' + encodeURIComponent(it.file);
    vid.controls = true;
    vid.loop = true;
    vid.muted = true;
    card.appendChild(vid);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const size = document.createElement('span');
    size.textContent = fmtBytes(it.bytes) || (it.bytes + ' B');
    meta.appendChild(size);

    const right = document.createElement('span');
    const show = document.createElement('button');
    show.type = 'button';
    show.textContent = 'Show';
    show.addEventListener('click', () => window.api.revealVideo(it.file));
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'rm';
    rm.textContent = 'Delete';
    rm.addEventListener('click', async () => { await window.api.deleteVideo(it.file); refreshGallery(); });
    right.append(show, rm);
    meta.appendChild(right);

    card.appendChild(meta);
    g.appendChild(card);
  }
}

window.api.onVideoProgress(({ requestId, stage, detail, elapsed }) => {
  if (requestId !== videoJobId) return;
  const est = estimateSeconds(videoParams());
  const pct = Math.min(96, (elapsed / est) * 100);
  $('#v-bar').style.width = pct.toFixed(1) + '%';
  $('#v-progress-text').textContent =
    detail + ' — ' + Math.round(elapsed) + 's elapsed, roughly ' +
    Math.max(0, Math.round(est - elapsed)) + 's to go';
});

$('#v-generate').addEventListener('click', async () => {
  if (videoJobId) return;
  const p = videoParams();
  if (!p.prompt) { showVideoError('Describe the shot you want first.'); return; }

  $('#v-error').classList.add('hidden');
  if (!(await refreshEngineStatus())) {
    showVideoError('The video engine is not running. Press Start engine, then try again.');
    return;
  }

  videoJobId = uid();
  $('#v-generate').disabled = true;
  $('#v-cancel').classList.remove('hidden');
  $('#v-progress').classList.remove('hidden');
  $('#v-bar').style.width = '0%';
  $('#v-progress-text').textContent = 'Starting…';

  // A reference photo has to live inside ComfyUI's input folder before a
  // workflow can load it by name.
  let imageName = null;
  if (p.engine === 'wan22' && p.imagePath) {
    try {
      $('#v-progress-text').textContent = 'Uploading reference photo…';
      const up = await window.api.uploadImage(p.imagePath);
      imageName = up.name;
    } catch (err) {
      videoJobId = null;
      $('#v-generate').disabled = false;
      $('#v-cancel').classList.add('hidden');
      $('#v-progress').classList.add('hidden');
      showVideoError('Could not upload the reference photo: ' + err.message);
      return;
    }
  }

  const r = await window.api.generateVideo({ ...p, imageName, requestId: videoJobId });

  videoJobId = null;
  $('#v-generate').disabled = false;
  $('#v-cancel').classList.add('hidden');

  if (r.ok) {
    $('#v-bar').style.width = '100%';
    $('#v-progress-text').textContent =
      'Done in ' + Math.round(r.seconds) + 's — saved as ' + r.file + '. Press Open to view it.';
    await refreshGallery();
  } else if (r.cancelled) {
    $('#v-progress').classList.add('hidden');
  } else {
    $('#v-progress').classList.add('hidden');
    showVideoError(r.error || 'Generation failed.');
  }
});

$('#v-cancel').addEventListener('click', async () => {
  if (videoJobId) await window.api.cancelVideo(videoJobId);
});

/* ------------------------------------------------------------------ */
/* Boot                                                                 */
/* ------------------------------------------------------------------ */

(async function boot() {
  await loadState();
  if (settings.codePanelWidth) {
    el.panel.style.width = settings.codePanelWidth + 'px';
    el.panel.style.flexBasis = settings.codePanelWidth + 'px';
  }
  renderChatList();

  const ok = await initServer();
  await refreshModels();

  // The user can click around while boot is still awaiting Ollama, so only pick a
  // conversation if nothing is selected yet. Clobbering here used to strand the
  // reply in an orphaned chat.
  if (!currentId) {
    if (conversations.length) openChat(conversations[0].id);
    else newChat();
  } else {
    renderChatList();
  }

  if (ok && !models.length) {
    showSystemError(
      'Ollama is running, but no models are installed yet.\n\n' +
      'Open Models in the sidebar and download qwen3:4b — it fits fully in your GPU.'
    );
  }
  updateEstimate();
  refreshExtUi();
  setInterval(refreshExtUi, 4000);
  el.input.focus();

  setInterval(async () => {
    if (!activeRequestId) return;
    const running = await window.api.listRunning();
    if (running.length) {
      const m = running[0];
      const onGpu = m.sizeVram > 0 && m.sizeVram >= m.size * 0.95;
      setStatus('ok', m.name.split(':')[0] + (onGpu ? ' · GPU' : ' · GPU+CPU'));
    }
  }, 5000);
})();
