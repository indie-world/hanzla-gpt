'use strict';
/* Unit test for the leaked-tool-call fallback parser, using the exact
   (including malformed) strings that showed up in real conversations. */

const TOOL_NAMES = ['open_page', 'read_current_page', 'list_tabs', 'click_on', 'type_text', 'extract_links', 'scroll_page', 'save_rows_to_file'];

// Mirrors extractInlineToolCall() in src/main.js exactly.
function extractInlineToolCall(text) {
  if (!text) return null;
  const nameRe = new RegExp('"name"\\s*:\\s*"(' + TOOL_NAMES.join('|') + ')"');
  const m = nameRe.exec(text);
  if (!m) return null;

  const toolName = m[1];
  let args = {};

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
      } catch { /* fall through */ }
    }
  }

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

const log = (...a) => console.log('[fp]', ...a);
let fails = 0;
const check = (ok, label, detail) => {
  log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '  — ' + detail : ''));
  if (!ok) fails++;
};

// --- real examples from the actual broken conversation -------------------

const case1 = extractInlineToolCall(
  'To apply filters only target USA based studios, I need to navigate to the search results page.\n\n' +
  '{"name": "open_page", "parameters": {"url":"https://www.linkedin.com/search/region/United+States/"}}'
);
check(case1 && case1.name === 'open_page', 'case 1: name extracted', JSON.stringify(case1));
check(case1 && case1.arguments.url === 'https://www.linkedin.com/search/region/United+States/',
  'case 1: url extracted from well-formed JSON', JSON.stringify(case1 && case1.arguments));

const case2 = extractInlineToolCall('{"name": "list_tabs", "{}"}');
check(case2 && case2.name === 'list_tabs', 'case 2 (malformed JSON): name still extracted', JSON.stringify(case2));
check(case2 && Object.keys(case2.arguments).length === 0, 'case 2: falls back to empty args safely (list_tabs needs none)');

const case3 = extractInlineToolCall(
  '{"name": "open_page", "parameters": {"url": "https://www.linkedin.com/companies"}}'
);
check(case3 && case3.name === 'open_page' && case3.arguments.url === 'https://www.linkedin.com/companies',
  'case 3: second real example parses correctly', JSON.stringify(case3));

// --- must NOT trigger on normal prose --------------------------------
const normal = extractInlineToolCall('Sure, I opened the page and the heading says "Example Domain".');
check(normal === null, 'ordinary prose does not falsely trigger the fallback');

// --- must NOT trigger on an unrelated JSON blob the user might paste -----
const unrelated = extractInlineToolCall('{"name": "some_other_thing", "value": 1}');
check(unrelated === null, 'JSON with an unknown tool name is ignored');

// --- permissive field recovery on a near-miss format ----------------------
const case4 = extractInlineToolCall('{"name": "click_on", "description": "United States"}');
check(case4 && case4.name === 'click_on' && case4.arguments.description === 'United States',
  'case 4: flat (non-nested) argument shape also recovered', JSON.stringify(case4));

log(fails === 0 ? 'ALL FALLBACK PARSER CHECKS PASSED' : fails + ' FAILED');
process.exit(fails === 0 ? 0 : 1);
