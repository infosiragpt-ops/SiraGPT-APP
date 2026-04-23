/**
 * task-tools — the tool registry the Claude-style task agent can
 * use. These are `react-agent`-shaped objects:
 *   { name, description, parameters, execute(args, ctx) → result }
 *
 * Design notes:
 * - Each tool wraps existing siraGPT infrastructure (code-sandbox,
 *   doc-generator, agentic search, filesystem skills). Nothing
 *   brand-new is introduced at the service layer.
 * - Tools return plain JSON-serialisable objects so the ReAct loop
 *   can stuff them into the next `role: tool` message. They also
 *   return a `_preview` string the UI can show without exposing
 *   the whole payload in the agent's trace.
 * - Tools honour the caller's `ctx.onEvent` hook so step output
 *   (stdout lines, fetched source titles, etc.) can stream to the
 *   SSE route in real time instead of waiting for the step to end.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sandbox = require('./code-sandbox');

// Resolve the agentic batch lazily so unit tests that don't need
// search don't pay the module-load cost or need OpenRouter creds.
let agenticBatchMod;
function getAgenticBatch() {
  if (!agenticBatchMod) agenticBatchMod = require('../searchBrain/agenticBatch');
  return agenticBatchMod;
}

// Shared artifact drop-box: files the agent creates land here so the
// route can serve them via GET /api/agent/artifact/:id. We derive a
// stable id from SHA1(content) so re-generating the same payload
// doesn't create duplicate files on disk.
const ARTIFACT_DIR = process.env.AGENT_ARTIFACT_DIR
  || path.join(process.cwd(), 'uploads', 'agent-artifacts');

function ensureArtifactDir() {
  if (!fs.existsSync(ARTIFACT_DIR)) {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  }
}

function artifactIdFor(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
}

const EXTENSION_TO_MIME = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf:  'application/pdf',
  svg:  'image/svg+xml',
  csv:  'text/csv',
  txt:  'text/plain',
  json: 'application/json',
  md:   'text/markdown',
};

function saveArtifact({ filename, base64, mime }) {
  ensureArtifactDir();
  const clean = String(filename || 'artifact').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'artifact';
  const buf = Buffer.from(base64 || '', 'base64');
  const id = artifactIdFor(Buffer.concat([Buffer.from(clean), buf]));
  const ext = path.extname(clean).slice(1).toLowerCase() || 'bin';
  const stored = `${id}-${clean}`;
  const full = path.join(ARTIFACT_DIR, stored);
  fs.writeFileSync(full, buf);
  return {
    id,
    filename: clean,
    mime: mime || EXTENSION_TO_MIME[ext] || 'application/octet-stream',
    sizeBytes: buf.length,
    path: full,
    downloadUrl: `/api/agent/artifact/${id}?name=${encodeURIComponent(clean)}`,
  };
}

function previewText(s, max = 600) {
  if (typeof s !== 'string') s = JSON.stringify(s);
  if (s.length <= max) return s;
  return s.slice(0, max) + `…  (+${s.length - max} chars truncated)`;
}

// ─── Tool 1: python_exec ────────────────────────────────────────────────

const pythonExec = {
  name: 'python_exec',
  description: 'Run a short Python 3 script in an isolated sandbox (10 s wall-clock default, no network credentials, fresh temp dir). Returns stdout, stderr, exit code. Use for data wrangling, pandas/openpyxl table construction, numeric computation, JSON shaping. Common deps pre-installed: pandas, numpy, openpyxl, python-docx, python-pptx, reportlab, PIL, matplotlib.',
  parameters: {
    type: 'object',
    properties: {
      source: { type: 'string', description: 'The full Python source to execute. Multi-line allowed.' },
      timeoutMs: { type: 'integer', minimum: 500, maximum: 60000, description: 'Wall-clock timeout in ms (default 10000).' },
      stdin: { type: 'string', description: 'Optional stdin for the script.' },
    },
    required: ['source'],
    additionalProperties: false,
  },
  async execute({ source, timeoutMs, stdin }, ctx = {}) {
    ctx.onEvent?.({ type: 'tool_call', tool: 'python_exec', preview: previewText(source, 400), language: 'python' });
    const r = await sandbox.run({
      language: 'python',
      source,
      timeoutMs: timeoutMs || 10000,
      stdin: stdin || '',
    });
    const payload = {
      ok: r.ok,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      timedOut: r.timedOut,
      stdout: previewText(r.stdout || '', 4000),
      stderr: previewText(r.stderr || '', 2000),
    };
    ctx.onEvent?.({
      type: 'tool_output',
      tool: 'python_exec',
      ok: payload.ok,
      preview: payload.ok
        ? previewText(r.stdout || '(no stdout)', 600)
        : previewText(r.stderr || '(no stderr)', 600),
    });
    return payload;
  },
};

// ─── Tool 2: bash_exec (via node child_process through sandbox's node language) ─

const bashExec = {
  name: 'bash_exec',
  description: 'Run a short Node.js script snippet (used for quick JSON shaping / HTTP-free data work). For unsafe-looking shell ops, use python_exec with subprocess instead. Same sandbox policy as python_exec.',
  parameters: {
    type: 'object',
    properties: {
      source: { type: 'string', description: 'The full Node.js source to execute.' },
      timeoutMs: { type: 'integer', minimum: 500, maximum: 30000 },
    },
    required: ['source'],
    additionalProperties: false,
  },
  async execute({ source, timeoutMs }, ctx = {}) {
    ctx.onEvent?.({ type: 'tool_call', tool: 'bash_exec', preview: previewText(source, 400), language: 'javascript' });
    const r = await sandbox.run({ language: 'javascript', source, timeoutMs: timeoutMs || 8000 });
    const payload = {
      ok: r.ok, exitCode: r.exitCode, durationMs: r.durationMs, timedOut: r.timedOut,
      stdout: previewText(r.stdout || '', 4000), stderr: previewText(r.stderr || '', 2000),
    };
    ctx.onEvent?.({ type: 'tool_output', tool: 'bash_exec', ok: r.ok, preview: payload.ok ? previewText(r.stdout || '', 600) : previewText(r.stderr || '', 600) });
    return payload;
  },
};

// ─── Tool 3: web_search (agentic multi-provider) ────────────────────────

const webSearch = {
  name: 'web_search',
  description: 'Run the agentic multi-provider search (Scopus + OpenAlex + SciELO + Semantic Scholar + Crossref + PubMed + DOAJ). Returns a compact list of top sources with title, authors, year, journal, doi, url. Use when the user asks for real citations, fresh data, or academic references.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to search for.' },
      topK:  { type: 'integer', minimum: 5, maximum: 50, description: 'How many top sources to return after rerank (default 15).' },
      target: { type: 'integer', minimum: 20, maximum: 500, description: 'Total sources to collect before reranking (default 100).' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async execute({ query, topK = 15, target = 100 }, ctx = {}) {
    ctx.onEvent?.({ type: 'tool_call', tool: 'web_search', preview: query });
    const { runAgenticBatch } = getAgenticBatch();
    const collected = [];
    let selected = [];
    let stats = null;
    try {
      for await (const evt of runAgenticBatch({
        query,
        target,
        batchSize: 10,
        topK,
        mailto: ctx.userEmail || process.env.SEARCH_BRAIN_MAILTO,
        signal: ctx.signal,
      })) {
        if (evt.type === 'batch') {
          ctx.onEvent?.({
            type: 'tool_output',
            tool: 'web_search',
            preview: `${evt.provider}: +${evt.unique} (${evt.totalCollected}/${evt.target})`,
            partial: true,
          });
        } else if (evt.type === 'selected') {
          selected = evt.sources || [];
        } else if (evt.type === 'done') {
          stats = evt.stats;
        }
      }
    } catch (err) {
      ctx.onEvent?.({ type: 'tool_output', tool: 'web_search', ok: false, preview: err.message || String(err) });
      return { ok: false, error: err.message || String(err), sources: [] };
    }
    const payload = {
      ok: true,
      sources: selected.map(s => ({
        title: s.title,
        authors: Array.isArray(s.authors) ? s.authors.slice(0, 5) : [],
        year: s.year,
        journal: s.journal,
        doi: s.doi,
        url: s.url,
        openAccess: s.openAccess,
        citationCount: s.citationCount,
      })),
      stats,
    };
    ctx.onEvent?.({
      type: 'tool_output',
      tool: 'web_search',
      ok: true,
      preview: `${payload.sources.length} fuentes top (${stats?.dedupedCount || 0} recopiladas)`,
    });
    return payload;
  },
};

// ─── Tool 4: create_document (via Python in sandbox writing XLSX/DOCX/PPTX/PDF) ─
//
// The agent emits a full Python script that writes to OUT_PATH. We
// execute it in the sandbox, read the resulting file, and register
// it as a downloadable artifact. This matches how doc-generator.js
// works but skips the second LLM call — the main agent already has
// enough context to write the script itself.

const createDocument = {
  name: 'create_document',
  description: 'Execute a Python script that writes a downloadable file (.xlsx / .docx / .pptx / .pdf / .csv / .svg / .md / .txt) to the path in the env var OUT_PATH. The framework will pick up the file and register it as a user-downloadable artifact. Use python-docx, openpyxl, python-pptx, reportlab — all pre-installed. The script MUST write to os.environ["OUT_PATH"].',
  parameters: {
    type: 'object',
    properties: {
      filename: { type: 'string', description: 'Filename including extension (xlsx/docx/pptx/pdf/csv/svg/md/txt). Max 120 chars.' },
      python:   { type: 'string', description: 'Full Python source. It must write the final file to os.environ["OUT_PATH"].' },
      description: { type: 'string', description: 'One-line human-readable description for the step card.' },
      timeoutMs: { type: 'integer', minimum: 1000, maximum: 60000 },
    },
    required: ['filename', 'python'],
    additionalProperties: false,
  },
  async execute({ filename, python, description, timeoutMs }, ctx = {}) {
    ensureArtifactDir();
    const cleanName = String(filename).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'artifact.bin';
    const tmpOut = path.join(ARTIFACT_DIR, `pending-${Date.now()}-${cleanName}`);
    const ext = path.extname(cleanName).slice(1).toLowerCase();

    ctx.onEvent?.({
      type: 'tool_call',
      tool: 'create_document',
      preview: description || `Generando ${cleanName}`,
      language: 'python',
      codePreview: previewText(python, 400),
    });

    // Inject OUT_PATH env into the script via os.environ before the
    // agent's code runs. We write a tiny bootstrap that ensures the
    // var is present for any pattern (os.environ.get / os.getenv).
    const wrapped = `import os\nos.environ["OUT_PATH"] = ${JSON.stringify(tmpOut)}\n${python}`;

    const r = await sandbox.run({
      language: 'python',
      source: wrapped,
      timeoutMs: timeoutMs || 30000,
    });

    if (!r.ok || !fs.existsSync(tmpOut)) {
      try { if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch { /* best effort */ }
      const payload = {
        ok: false,
        error: r.timedOut ? 'timeout' : (r.stderr || 'script did not write OUT_PATH'),
        stderr: previewText(r.stderr || '', 1200),
        stdout: previewText(r.stdout || '', 600),
      };
      ctx.onEvent?.({ type: 'tool_output', tool: 'create_document', ok: false, preview: previewText(payload.error, 600) });
      return payload;
    }

    const raw = fs.readFileSync(tmpOut);
    const b64 = raw.toString('base64');
    const artifact = saveArtifact({ filename: cleanName, base64: b64, mime: EXTENSION_TO_MIME[ext] });
    try { fs.unlinkSync(tmpOut); } catch { /* may have been moved */ }

    ctx.onEvent?.({
      type: 'file_artifact',
      artifact: {
        id: artifact.id,
        filename: artifact.filename,
        mime: artifact.mime,
        sizeBytes: artifact.sizeBytes,
        downloadUrl: artifact.downloadUrl,
      },
    });

    ctx.onEvent?.({
      type: 'tool_output',
      tool: 'create_document',
      ok: true,
      preview: `Archivo listo: ${artifact.filename} (${Math.round(artifact.sizeBytes / 1024)} KB)`,
    });

    return {
      ok: true,
      filename: artifact.filename,
      sizeBytes: artifact.sizeBytes,
      mime: artifact.mime,
      downloadUrl: artifact.downloadUrl,
      stdout: previewText(r.stdout || '', 1200),
    };
  },
};

// ─── Tool 5: read_skill_file (RAG read) ─────────────────────────────────

const ragRetrieve = {
  name: 'rag_retrieve',
  description: 'Retrieve up to K chunks from the user\'s private knowledge collection. Use when the user refers to their own uploaded docs or says "según mis PDFs".',
  parameters: {
    type: 'object',
    properties: {
      query:      { type: 'string', description: 'What to retrieve.' },
      k:          { type: 'integer', minimum: 1, maximum: 20, description: 'How many chunks (default 4).' },
      collection: { type: 'string', description: 'Collection name (defaults to "default").' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async execute({ query, k = 4, collection }, ctx = {}) {
    if (!ctx.userId) {
      return { ok: false, error: 'rag_retrieve requires an authenticated userId in ctx' };
    }
    ctx.onEvent?.({ type: 'tool_call', tool: 'rag_retrieve', preview: query });
    try {
      const rag = require('../rag-service');
      const hits = await rag.retrieve(ctx.userId, collection || ctx.collection || 'default', query, k);
      ctx.onEvent?.({ type: 'tool_output', tool: 'rag_retrieve', ok: true, preview: `${hits?.length || 0} chunks` });
      return { ok: true, hits };
    } catch (err) {
      ctx.onEvent?.({ type: 'tool_output', tool: 'rag_retrieve', ok: false, preview: err.message });
      return { ok: false, error: err.message };
    }
  },
};

// ─── Assembly ──────────────────────────────────────────────────────────

/**
 * @returns {Array<object>} the tools array to pass into react-agent's
 * `tools` parameter.
 */
function buildTaskTools() {
  return [pythonExec, bashExec, webSearch, createDocument, ragRetrieve];
}

module.exports = {
  buildTaskTools,
  saveArtifact,
  ARTIFACT_DIR,
  EXTENSION_TO_MIME,
  INTERNAL: { pythonExec, bashExec, webSearch, createDocument, ragRetrieve, previewText, artifactIdFor },
};
