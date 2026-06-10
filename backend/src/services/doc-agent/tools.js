'use strict';

/**
 * Document-agent tools — the five Cowork-style primitives exposed to the
 * model via OpenAI/OpenRouter function calling, bound to ONE sandbox session:
 *
 *   bash         run a shell command inside /workspace (120s cap)
 *   read_file    read a file (text, with offset/limit lines)
 *   write_file   create/overwrite a file (parent dirs auto-created)
 *   str_replace  surgical edit — old_str must match EXACTLY ONCE
 *   list_files   recursive listing with sizes
 *
 * Every result is a plain string (JSON for structured cases) capped in size;
 * errors come back as `ERROR: …` strings so the loop NEVER throws on a tool —
 * the model sees the failure and adapts, mirroring the agent-harness
 * convention used elsewhere in this repo.
 */

const MAX_TOOL_RESULT_CHARS = 30_000;

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description:
        'Run a bash command inside the isolated /workspace sandbox. Uploaded files are in /workspace/uploads; write every deliverable to /workspace/outputs. Available: python3 (python-docx, openpyxl, python-pptx, pypdf, mammoth, lxml when the container image is used), zip/unzip, sed/grep/awk, libreoffice --headless. 120s timeout per command; no network.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The bash command to execute.' },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file from the workspace. Paths are relative to /workspace (e.g. "uploads/doc.docx" or "/workspace/tmp/word/document.xml"). Binary files: use bash + python instead.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to /workspace.' },
          offset: { type: 'integer', description: '1-based first line to read (optional).' },
          limit: { type: 'integer', description: 'Max number of lines to return (optional, default 400).' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a file in the workspace with the given UTF-8 content. Parent directories are created automatically.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to /workspace.' },
          content: { type: 'string', description: 'Full file content to write.' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'str_replace',
      description: 'Surgical text edit: replace old_str with new_str in a file. old_str MUST occur exactly once (include enough surrounding context to make it unique). Use this for precise XML/document edits instead of rewriting whole files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to /workspace.' },
          old_str: { type: 'string', description: 'Exact existing text to replace (must be unique in the file).' },
          new_str: { type: 'string', description: 'Replacement text.' },
        },
        required: ['path', 'old_str', 'new_str'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files (recursively) under a workspace directory with their sizes in bytes.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory relative to /workspace (default ".").' },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
];

function cap(s) {
  const str = String(s == null ? '' : s);
  return str.length > MAX_TOOL_RESULT_CHARS
    ? `${str.slice(0, MAX_TOOL_RESULT_CHARS)}\n…[result truncated]`
    : str;
}

/**
 * Bind executors to a sandbox session.
 * @param {import('./sandbox')} sandbox
 * @returns {Record<string, (args: any) => Promise<string>>}
 */
function makeToolExecutors(sandbox) {
  return {
    async bash(args) {
      const command = String(args?.command || '').trim();
      if (!command) return 'ERROR: empty command';
      const r = await sandbox.exec(command);
      const parts = [];
      if (r.stdout) parts.push(r.stdout);
      if (r.stderr) parts.push(`[stderr] ${r.stderr}`);
      parts.push(r.timedOut ? `[exit ${r.exitCode} — TIMED OUT]` : `[exit ${r.exitCode}]`);
      return cap(parts.join('\n'));
    },

    async read_file(args) {
      try {
        const buf = await sandbox.readFile(String(args?.path || ''));
        const text = buf.toString('utf8');
        if (text.includes('\u0000')) {
          return `ERROR: ${args.path} looks binary (${buf.length} bytes). Inspect it with bash + python3 instead.`;
        }
        const lines = text.split('\n');
        const offset = Math.max(1, Number(args?.offset) || 1);
        const limit = Math.max(1, Math.min(2000, Number(args?.limit) || 400));
        const slice = lines.slice(offset - 1, offset - 1 + limit);
        const numbered = slice.map((l, i) => `${offset + i}\t${l}`).join('\n');
        const more = offset - 1 + limit < lines.length ? `\n…[${lines.length - (offset - 1 + limit)} more lines]` : '';
        return cap(numbered + more);
      } catch (err) {
        return `ERROR: ${err.message}`;
      }
    },

    async write_file(args) {
      try {
        const p = String(args?.path || '');
        const content = String(args?.content ?? '');
        await sandbox.writeFile(p, content);
        return `OK: wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${p}`;
      } catch (err) {
        return `ERROR: ${err.message}`;
      }
    },

    async str_replace(args) {
      try {
        const p = String(args?.path || '');
        const oldStr = String(args?.old_str ?? '');
        const newStr = String(args?.new_str ?? '');
        if (!oldStr) return 'ERROR: old_str must not be empty';
        const buf = await sandbox.readFile(p);
        const text = buf.toString('utf8');
        const first = text.indexOf(oldStr);
        if (first === -1) return `ERROR: old_str not found in ${p}. Read the file and copy the exact text (including whitespace).`;
        const second = text.indexOf(oldStr, first + oldStr.length);
        if (second !== -1) return `ERROR: old_str occurs more than once in ${p}. Add surrounding context to make it unique.`;
        const updated = text.slice(0, first) + newStr + text.slice(first + oldStr.length);
        await sandbox.writeFile(p, updated);
        return `OK: replaced 1 occurrence in ${p}`;
      } catch (err) {
        return `ERROR: ${err.message}`;
      }
    },

    async list_files(args) {
      try {
        const files = await sandbox.listFiles(String(args?.path || '.') || '.');
        if (!files.length) return '(no files)';
        return cap(files.map((f) => `${f.size}\t${f.path}`).join('\n'));
      } catch (err) {
        return `ERROR: ${err.message}`;
      }
    },
  };
}

module.exports = { TOOL_DEFINITIONS, makeToolExecutors, MAX_TOOL_RESULT_CHARS };
