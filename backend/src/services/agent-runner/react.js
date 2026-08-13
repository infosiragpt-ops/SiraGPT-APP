'use strict';

/**
 * ReAct text fallback for models that cannot emit native tool_calls.
 * Accepts several common shapes so Deepseek / open-source models still drive
 * the loop:
 *
 *   Action: execute_python
 *   Action Input: print(1)
 *
 *   ```tool
 *   {"name":"execute_python","arguments":{"code":"print(1)"}}
 *   ```
 *
 *   execute_python
 *   ```python
 *   print(1)
 *   ```
 */

const KNOWN = new Set([
  'execute_python',
  'execute_bash',
  'bash',
  'read_file',
  'write_file',
  'edit_file',
  'list_files',
  'glob',
  'grep',
  'render_preview',
  'set_slide_background',
  'create_presentation',
  'str_replace',
]);

function parseJsonish(raw) {
  const s = String(raw || '').trim();
  if (!s) return {};
  try { return JSON.parse(s); } catch (_) { /* fall through */ }
  // Bare python/bash bodies become { code } or { command }.
  return { __raw: s };
}

function parseReact(text) {
  const src = String(text || '');
  const calls = [];

  const fence = /```tool\s*([\s\S]*?)```/gi;
  let m;
  while ((m = fence.exec(src))) {
    try {
      const obj = JSON.parse(m[1].trim());
      const name = String(obj.name || obj.tool || '').trim();
      if (KNOWN.has(name)) {
        calls.push({ name, args: obj.arguments || obj.args || obj.input || {} });
      }
    } catch (_) { /* ignore bad fence */ }
  }

  const actionRe = /Action\s*:\s*([a-z_]+)\s*(?:\n|\r\n)Action\s*Input\s*:\s*([\s\S]*?)(?=\nAction\s*:|\nObservation\s*:|\nFinal\s*Answer\s*:|$)/gi;
  while ((m = actionRe.exec(src))) {
    const name = String(m[1] || '').trim();
    if (!KNOWN.has(name)) continue;
    let args = parseJsonish(m[2]);
    if (args.__raw) {
      if (name === 'execute_python') args = { code: args.__raw };
      else if (name === 'execute_bash' || name === 'bash') args = { command: args.__raw };
      else if (name === 'read_file' || name === 'list_files' || name === 'render_preview') args = { path: args.__raw };
      else if (name === 'glob') args = { pattern: args.__raw };
      else if (name === 'grep') args = { pattern: args.__raw };
      else if (name === 'set_slide_background') args = { color: args.__raw };
      else args = { input: args.__raw };
    }
    calls.push({ name, args });
  }

  const pyFence = /(?:^|\n)\s*(execute_python)\s*\n```(?:python)?\s*([\s\S]*?)```/gi;
  while ((m = pyFence.exec(src))) {
    calls.push({ name: 'execute_python', args: { code: m[2] } });
  }

  const bashFence = /(?:^|\n)\s*(execute_bash|bash)\s*\n```(?:bash|sh)?\s*([\s\S]*?)```/gi;
  while ((m = bashFence.exec(src))) {
    calls.push({ name: 'execute_bash', args: { command: m[2] } });
  }

  // Dedup identical consecutive calls from overlapping patterns.
  const seen = new Set();
  return calls.filter((c) => {
    const key = `${c.name}:${JSON.stringify(c.args)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function looksLikeToolUnsupportedError(err) {
  const msg = String(err && err.message || err || '').toLowerCase();
  return /tool[_\s-]?call|function.?call|tools? (are )?not supported|unknown parameter.*tools|does not support/i.test(msg);
}

module.exports = { parseReact, looksLikeToolUnsupportedError, KNOWN };
