'use strict';

/**
 * create_artifact — first-class artifact creation for the chat agent,
 * integrated with the EXISTING artifact system end-to-end:
 *
 *   - binaries persist through agents/task-tools.js `saveArtifact` (same
 *     store, size limits, R2 offload and /api/agent/artifact/:id download
 *     route every other artifact-producing tool uses), and
 *   - the result is announced via the same `file_artifact` ctx.onEvent the
 *     visual/media tools emit, so the chat bubble renders the preview /
 *     download card with ZERO new frontend plumbing.
 *
 * Use it for standalone deliverables the user will open, keep or iterate on
 * (an HTML page/app, an SVG graphic, a Markdown doc, a code file) — not for
 * normal prose answers, which belong in the message itself.
 */

const { z } = require('zod');

const MAX_CONTENT_CHARS = 300_000;

const TYPE_CONFIG = Object.freeze({
  html: { ext: 'html', mime: 'text/html' },
  svg: { ext: 'svg', mime: 'image/svg+xml' },
  markdown: { ext: 'md', mime: 'text/markdown' },
  code: { ext: 'txt', mime: 'text/plain' }, // ext refined via `language`
  json: { ext: 'json', mime: 'application/json' },
});

const CODE_EXTENSIONS = Object.freeze({
  javascript: 'js', typescript: 'ts', python: 'py', java: 'java', csharp: 'cs',
  go: 'go', rust: 'rs', ruby: 'rb', php: 'php', sql: 'sql', bash: 'sh',
  shell: 'sh', css: 'css', html: 'html', json: 'json', yaml: 'yml', xml: 'xml',
});

const inputSchema = z.object({
  title: z.string().min(1).max(120)
    .describe('Short human title for the artifact (also drives the filename)'),
  type: z.enum(['html', 'svg', 'markdown', 'code', 'json'])
    .describe('html = self-contained page/app, svg = vector graphic, markdown = document, code = source file, json = data file'),
  content: z.string().min(1).max(MAX_CONTENT_CHARS)
    .describe('The COMPLETE artifact content (a full standalone document — no placeholders, no "rest unchanged")'),
  language: z.string().max(24).optional()
    .describe('For type=code: the language (javascript, python, sql, …) — sets the file extension'),
  description: z.string().max(300).optional()
    .describe('One-line description shown next to the artifact'),
}).strict();

function slugifyTitle(title) {
  const slug = String(title || 'artifact')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9 _-]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 64);
  return slug || 'artifact';
}

function buildPreviewHtml(type, content) {
  if (type === 'html') return content;
  if (type === 'svg') {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:16px;display:grid;place-items:center;background:transparent}svg{max-width:100%;height:auto}</style></head><body>${content}</body></html>`;
  }
  return null;
}

function buildCreateArtifactTool() {
  return {
    name: 'create_artifact',
    description: [
      'Create a standalone artifact (HTML page/app, SVG graphic, Markdown document, code or JSON file) that the user can preview, download and keep. The content must be COMPLETE and self-contained.',
      'WHEN TO USE: the user asks for a deliverable — an interactive page, a visual, a document, a script — or the answer is substantial structured content (>15 lines) they will reuse outside the chat.',
      'WHEN NOT TO USE: for normal explanations or short snippets (answer in the message); for Word/Excel/PDF/PPT files (use create_document); for charts/diagrams with data (the dedicated create_chart / diagram tools render better).',
    ].join(' '),
    inputSchema,
    permissionTier: 'auto',
    humanDescription: (args = {}) => `Creando artifact: ${String(args.title || 'sin título').slice(0, 60)}`,
    execute: async (args, ctx = {}) => {
      const config = TYPE_CONFIG[args.type];
      const ext = args.type === 'code'
        ? (CODE_EXTENSIONS[String(args.language || '').toLowerCase()] || 'txt')
        : config.ext;
      const filename = `${slugifyTitle(args.title)}.${ext}`;
      const { saveArtifact } = require('../../agents/task-tools');
      const saved = saveArtifact({
        filename,
        base64: Buffer.from(args.content, 'utf8').toString('base64'),
        mime: args.type === 'code' ? 'text/plain' : config.mime,
        ownerUserId: ctx.userId || null,
        chatId: ctx.chatId || null,
        category: 'agent_artifact',
        validation: null,
      });
      const previewHtml = buildPreviewHtml(args.type, args.content);
      if (ctx && typeof ctx.onEvent === 'function') {
        try {
          ctx.onEvent({
            type: 'file_artifact',
            artifact: {
              id: saved.id,
              filename: saved.filename,
              mime: saved.mime,
              format: saved.format,
              sizeBytes: saved.sizeBytes,
              downloadUrl: saved.downloadUrl,
              previewHtml,
              validation: null,
            },
          });
        } catch (_) { /* UI plumbing must never fail the tool */ }
      }
      return {
        ok: true,
        artifactId: saved.id,
        filename: saved.filename,
        type: args.type,
        sizeBytes: saved.sizeBytes,
        downloadUrl: saved.downloadUrl,
        ...(args.description ? { description: args.description } : {}),
        note: 'Artifact creado y visible para el usuario en el chat. Menciónalo brevemente en tu respuesta final; no repitas su contenido completo.',
      };
    },
  };
}

module.exports = {
  buildCreateArtifactTool,
  TYPE_CONFIG,
  MAX_CONTENT_CHARS,
  slugifyTitle,
};
