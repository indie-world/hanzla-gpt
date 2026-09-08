'use strict';
const WebSocket = require('ws');
function get(url) { return fetch(url).then((r) => r.json()); }
function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 10000);
    ws.on('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })));
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.id !== 1) return;
      clearTimeout(timer); ws.close();
      if (m.result && m.result.exceptionDetails) reject(new Error(JSON.stringify(m.result.exceptionDetails)));
      else resolve(m.result && m.result.result && m.result.result.value);
    });
    ws.on('error', reject);
  });
}
(async () => {
  const created = await (await fetch('http://127.0.0.1:9334/json/new?chrome://extensions/', { method: 'PUT' })).json();
  console.log('created:', JSON.stringify(created));
  await new Promise((r) => setTimeout(r, 2000));
  const list = await get('http://127.0.0.1:9334/json/list');
  const page = list.find((t) => t.url.startsWith('chrome://extensions'));
  console.log('page found:', !!page);
  if (page) {
    const text = await evaluate(page.webSocketDebuggerUrl, 'document.body.innerText');
    console.log('TEXT:', (text || '').slice(0, 3000));
  }
})().catch((e) => console.log('ERR', e.message));
