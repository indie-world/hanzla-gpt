'use strict';
function normalizeUrl(url) {
  const u = String(url || '').trim();
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(u)) return u;
  return 'https://' + u.replace(/^\/+/, '');
}
function fileUrl(fullPath) {
  return 'file:///' + fullPath.replace(/\\/g, '/');
}

const cases = [
  ['example.com', 'https://example.com'],
  ['linkedin.com/search', 'https://linkedin.com/search'],
  ['https://already.com', 'https://already.com'],
  ['file:///D:/Hanzla-GPT/Exports/x.csv', 'file:///D:/Hanzla-GPT/Exports/x.csv'],
];
let fails = 0;
for (const [input, expected] of cases) {
  const got = normalizeUrl(input);
  const ok = got === expected;
  console.log((ok ? 'PASS' : 'FAIL'), input, '->', got, ok ? '' : '(expected ' + expected + ')');
  if (!ok) fails++;
}

const fu = fileUrl('D:\\Hanzla-GPT\\Exports\\usa-game-studios.csv');
const okFu = fu === 'file:///D:/Hanzla-GPT/Exports/usa-game-studios.csv';
console.log((okFu ? 'PASS' : 'FAIL'), 'fileUrl backslash conversion ->', fu);
if (!okFu) fails++;

console.log(fails === 0 ? 'ALL URL HELPER CHECKS PASSED' : fails + ' FAILED');
process.exit(fails === 0 ? 0 : 1);
