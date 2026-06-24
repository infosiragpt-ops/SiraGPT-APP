'use strict';

/**
 * sandbox-doc-tools — 4 harness tools for document editing in isolated sessions.
 *
 * Tools exposed to the model:
 *   sandbox_bash   — run bash/python in the session workdir
 *   sandbox_read   — read a file from the session workdir
 *   sandbox_write  — write a file to the session workdir
 *   sandbox_patch  — exact-string replacement inside a file
 *
 * All operations are confined to the session's temp directory. Path escape
 * attempts are rejected with an error fed back to the model.
 *
 * These tools are only registered when a sandbox sessionId is present in
 * the agent turn context. The buildSandboxDocTools() factory accepts the
 * sessionId at registration time so the model never needs to pass it as
 * an argument (reduces hallucination surface).
 */

const { z }    = require('zod');
const sandbox  = require('../sandbox/session-manager');
const { executeCode } = require('../sandbox/router');

const EXEC_TIMEOUT_MS   = parseInt(process.env.SANDBOX_EXEC_TIMEOUT_MS || '60000', 10);
const MAX_OUTPUT_CHARS  = 8_000;

function truncate(str, max = MAX_OUTPUT_CHARS) {
  if (typeof str !== 'string') str = String(str || '');
  if (str.length <= max) return str;
  return str.slice(0, max) + `\n... [truncated ${str.length - max} chars]`;
}

/**
 * Build the 4 sandbox document tools bound to a specific sessionId.
 *
 * @param {string} sessionId
 * @returns {Array<ToolDef>} — array of tool definition objects ready for
 *   registry.register() in run-agent-turn.js
 */
function buildSandboxDocTools(sessionId) {
  const sess = sandbox.getSession(sessionId);
  if (!sess) throw new Error(`sandbox_doc_tools: session ${sessionId} not found`);
  const { workdir } = sess;

  return [
    // ── sandbox_bash ────────────────────────────────────────────────────────
    {
      name: 'sandbox_bash',
      description: [
        'Run a bash or Python command inside the document editing sandbox.',
        'The working directory is already set to the session workdir containing the uploaded file.',
        'Use this to manipulate documents with python-docx, openpyxl, pypdf, pandas, csv, or any shell tool.',
        '',
        'WHEN TO USE: executing python scripts, inspecting file contents, installing nothing (deps are pre-installed).',
        'WHEN NOT TO USE: reading/writing plain text files — use sandbox_read / sandbox_write instead (faster).',
        '',
        'Available Python libs: python-docx, openpyxl, pypdf, reportlab, pandas, csv (stdlib).',
        'Available shell: bash, python3, ls, cat, head, file, wc.',
        'Network: BLOCKED. No pip install during session.',
      ].join('\n'),
      permissionTier: 'auto',
      inputSchema: z.object({
        language: z.enum(['bash', 'python']).default('python')
          .describe("'python' or 'bash'. Default: 'python'."),
        code: z.string().min(1).max(20_000)
          .describe('The code to execute. Working dir is already the session workdir.'),
        timeoutMs: z.number().int().min(1000).max(EXEC_TIMEOUT_MS).optional()
          .describe(`Execution timeout in ms (max ${EXEC_TIMEOUT_MS})`),
      }),
      humanDescription: (args) => `Ejecutando ${args.language || 'python'} en sandbox`,
      timeoutMs: EXEC_TIMEOUT_MS + 5_000,
      execute: async ({ language, code, timeoutMs }) => {
        sandbox.touchSession(sessionId);

        // No chdir preamble: the local backend already runs with cwd=workdir,
        // and the remote backend syncs workdir files into the container's
        // /workspace (an absolute local path would not exist there anyway).
        // e2b is excluded for THIS call path: it has no file sync, so doc
        // commands would run against an empty VM and "succeed" misleadingly.
        const result = await executeCode({
          language: language === 'python' ? 'python' : 'bash',
          code,
          timeoutMs: timeoutMs || EXEC_TIMEOUT_MS,
          workdir,
        }, { ...process.env, SANDBOX_PREFERENCE: process.env.SANDBOX_DOC_TOOLS_PREFERENCE || 'remote,local' });

        sandbox.touchSession(sessionId);

        return {
          ok:       result.ok,
          stdout:   truncate(result.stdout || ''),
          stderr:   truncate(result.stderr || ''),
          exitCode: result.exitCode ?? (result.ok ? 0 : 1),
          backend:  result.backend || 'local',
          files:    sandbox.listFiles(sessionId),
        };
      },
    },

    // ── sandbox_read ────────────────────────────────────────────────────────
    {
      name: 'sandbox_read',
      description: [
        'Read a text file from the sandbox workdir.',
        'Returns the file contents (UTF-8). Binary files (docx, xlsx, pdf) should be',
        'read and manipulated via sandbox_bash with python libraries, not this tool.',
        'WHEN TO USE: reading .txt, .md, .csv, .py, .json or any text file.',
        'WHEN NOT TO USE: binary formats — use sandbox_bash + python-docx/openpyxl/pypdf.',
      ].join('\n'),
      permissionTier: 'auto',
      inputSchema: z.object({
        path: z.string().min(1).max(500)
          .describe('File path relative to the sandbox workdir'),
        maxBytes: z.number().int().min(100).max(512_000).optional()
          .describe('Max bytes to return (default 512000)'),
      }),
      humanDescription: (args) => `Leyendo ${args.path} del sandbox`,
      execute: async ({ path: filePath, maxBytes }) => {
        sandbox.touchSession(sessionId);
        return sandbox.readFile(sessionId, filePath, { maxBytes: maxBytes || 512_000 });
      },
    },

    // ── sandbox_write ───────────────────────────────────────────────────────
    {
      name: 'sandbox_write',
      description: [
        'Write (or overwrite) a text file in the sandbox workdir.',
        'Use this to create helper scripts (.py), config files, or plain-text output.',
        'For binary documents, write via sandbox_bash instead.',
        'WHEN TO USE: creating Python scripts to run with sandbox_bash, writing text output.',
      ].join('\n'),
      permissionTier: 'auto',
      inputSchema: z.object({
        path: z.string().min(1).max(500)
          .describe('File path relative to the sandbox workdir'),
        content: z.string().max(200_000)
          .describe('UTF-8 content to write'),
      }),
      humanDescription: (args) => `Escribiendo ${args.path} en sandbox`,
      execute: async ({ path: filePath, content }) => {
        sandbox.touchSession(sessionId);
        return sandbox.writeFile(sessionId, filePath, content);
      },
    },

    // ── sandbox_patch ───────────────────────────────────────────────────────
    {
      name: 'sandbox_patch',
      description: [
        'Surgical exact-string replacement inside a TEXT file in the sandbox workdir.',
        'All occurrences of old_text are replaced with new_text.',
        'Fails with "old_text_not_found" if the string is absent — use sandbox_read first',
        'to confirm the exact text, including whitespace and newlines.',
        'WHEN TO USE: small targeted edits to .py scripts, .csv, .txt, .md files.',
        'WHEN NOT TO USE: binary formats (docx/xlsx/pdf) — use sandbox_bash for those.',
      ].join('\n'),
      permissionTier: 'auto',
      inputSchema: z.object({
        path: z.string().min(1).max(500)
          .describe('File path relative to the sandbox workdir'),
        old_text: z.string().min(1).max(10_000)
          .describe('Exact string to find (including whitespace/newlines)'),
        new_text: z.string().max(10_000)
          .describe('Replacement string'),
      }),
      humanDescription: (args) => `Parcheando ${args.path} en sandbox`,
      execute: async ({ path: filePath, old_text, new_text }) => {
        sandbox.touchSession(sessionId);
        return sandbox.patchFile(sessionId, filePath, old_text, new_text);
      },
    },
  ];
}

module.exports = { buildSandboxDocTools };
