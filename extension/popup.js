'use strict';

const dot = document.getElementById('dot');
const status = document.getElementById('status');
const hint = document.getElementById('hint');

function paint(connected) {
  dot.className = 'dot ' + (connected ? 'ok' : 'bad');
  status.textContent = connected ? 'Linked to Hanzla-GPT' : 'Not linked';
  hint.textContent = connected
    ? 'The app can read and open pages in this browser.'
    : 'Make sure Hanzla-GPT is running on this computer, then press Reconnect.';
}

chrome.runtime.sendMessage({ type: '__status' }, (res) => {
  if (chrome.runtime.lastError) { paint(false); return; }
  paint(!!(res && res.connected));
});

document.getElementById('retry').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: '__reconnect' }, () => {
    setTimeout(() => {
      chrome.runtime.sendMessage({ type: '__status' }, (res) => {
        paint(!chrome.runtime.lastError && !!(res && res.connected));
      });
    }, 1200);
  });
});
