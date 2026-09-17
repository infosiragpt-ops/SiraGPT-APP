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

function loadEngine3h61() {
  try { return require('../agent-runner/engine-3h61'); } catch (_) { return null; }
}

function loadEngine3h62() {
  try { return require('../agent-runner/engine-3h62'); } catch (_) { return null; }
}

function loadEngineAdapter() {
  try { return require('../agent-runner/engine-adapter'); } catch (_) { return null; }
}

async function runMutatingSandboxWrite(sandbox, { tool, path: filePath, execute }) {
  const adapter = loadEngineAdapter();
  if (adapter && typeof adapter.checkpointHookBeforeMutatingTool === 'function') {
    adapter.checkpointHookBeforeMutatingTool({ tool, path: filePath, name: tool });
  }
  let beforeBytes = null;
  try { beforeBytes = await sandbox.readFile(String(filePath)); } catch (_) { beforeBytes = null; }
  const w61 = loadEngine3h61();
  if (!w61 || typeof w61.guardMutatingWriteClosed !== 'function') {
    return execute();
  }
  const guarded = await w61.guardMutatingWriteClosed({
    tool,
    path: filePath,
    name: tool,
    execute,
    readBytes: async (p) => {
      try { return await sandbox.readFile(String(p)); } catch (_) { return null; }
    },
    writeBytes: async (p, bytes) => {
      await sandbox.writeFile(String(p), bytes);
    },
  });
  const original = guarded && guarded.result;
  if (typeof original === 'string' && /old_str occurs more than once|old_str not found|old_str must not be empty/i.test(original)) {
    return original;
  }
  if (guarded && guarded.rolledBack && guarded.timedOut) {
    const classified = typeof w61.classifyPublicLoopErrorClosed === 'function'
      ? w61.classifyPublicLoopErrorClosed({ code: 'ckpt_rollback_timeout' })
      : { message: 'La escritura expiró. Revertí al checkpoint anterior.' };
    return `ERROR: ${classified.message}`;
  }
  if (guarded && !guarded.rolledBack && !guarded.timedOut) {
    try {
      const w62 = loadEngine3h62();
      if (w62 && typeof w62.validateWriteThenRevertClosed === 'function') {
        let afterBytes = null;
        try { afterBytes = await sandbox.readFile(String(filePath)); } catch (_) { afterBytes = null; }
        const validated = await w62.validateWriteThenRevertClosed({
          path: filePath,
          beforeBytes,
          afterBytes,
          restore: async (p, bytes) => { await sandbox.writeFile(String(p), bytes); },
          tool,
          result: original,
        });
        if (validated && validated.reverted) {
          const classified = typeof w62.classifyEngine3h62Error === 'function'
            ? w62.classifyEngine3h62Error({ code: validated.code || 'write_syntax_revert' })
            : { message: 'La escritura dejó sintaxis inválida. Restauré el original.' };
          return `ERROR: ${classified.message}`;
        }
      }
    } catch (_) { /* 3H62 fail-open: uniqueness/timeout messages stay distinct */ }
  }
  return original;
}

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
      const output = cap(parts.join('\n'));
      if (r.aborted || r.timedOut) {
        try {
          const adapter = loadEngineAdapter();
          const workdir = sandbox && (sandbox.workdir || sandbox.cwd || sandbox.sessionWorkdir);
          if (adapter && typeof adapter.sandboxTimeoutThenCleanup === 'function') {
            adapter.sandboxTimeoutThenCleanup({
              elapsedMs: Number(r.durationMs) || 120000,
              timeoutMs: Number(r.timeoutMs) || 120000,
              workdir,
            });
          }
          if (adapter && typeof adapter.sandboxReapOrphanWorkdirs === 'function' && workdir) {
            adapter.sandboxReapOrphanWorkdirs([{ path: workdir, orphan: true, mtimeMs: Date.now() }], { now: Date.now() });
          }
        } catch (_) { /* 3H59 fail-open */ }
      }
      if (r.aborted) return `ERROR: sandbox command aborted\n${output}`;
      if (r.timedOut) return `ERROR: sandbox command timed out\n${output}`;
      if (Number(r.exitCode) !== 0) return `ERROR: sandbox command failed\n${output}`;
      return output;
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
      const p = String(args?.path || '');
      const content = String(args?.content ?? '');
      return runMutatingSandboxWrite(sandbox, {
        tool: 'write_file',
        path: p,
        execute: async () => {
          try {
            await sandbox.writeFile(p, content);
            return `OK: wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${p}`;
          } catch (err) {
            return `ERROR: ${err.message}`;
          }
        },
      });
    },

    async str_replace(args) {
      const p = String(args?.path || '');
      const oldStr = String(args?.old_str ?? '');
      const newStr = String(args?.new_str ?? '');
      return runMutatingSandboxWrite(sandbox, {
        tool: 'str_replace',
        path: p,
        execute: async () => {
          try {
            if (!oldStr) return 'ERROR: old_str must not be empty';
            const buf = await sandbox.readFile(p);
            const text = buf.toString('utf8');
            if (text.includes('\u0000')) {
              return `ERROR: ${p} is a BINARY file (a .docx/.xlsx/.pptx is a ZIP archive — you cannot text-edit it directly). ` +
                `First unpack it (e.g. "mkdir -p /workspace/tmp/x && cd /workspace/tmp/x && unzip -o /workspace/uploads/${p.split('/').pop()}"), ` +
                `then str_replace inside the extracted word/document.xml, then repack with "cd /workspace/tmp/x && zip -q -r /workspace/outputs/NAME.docx ." — or use python3 (python-docx).`;
            }
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
      });
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
