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
const {
  MIN_QUALITY_SCORE,
  MIN_TECHNICAL_SCORE,
  validateDocument,
} = require('../document-pipeline/advanced-document-pipeline');

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

function artifactIdFor(buf, scope = '') {
  return crypto.createHash('sha1').update(scope).update(buf).digest('hex').slice(0, 16);
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

const ADVANCED_DOCUMENT_FORMATS = new Set(['docx', 'xlsx', 'pptx', 'pdf', 'csv', 'html', 'md']);

function metadataPathFor(id) {
  return path.join(ARTIFACT_DIR, `${id}.json`);
}

function saveArtifact({ filename, base64, mime, ownerUserId, chatId, validation }) {
  ensureArtifactDir();
  const clean = String(filename || 'artifact').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'artifact';
  const buf = Buffer.from(base64 || '', 'base64');
  const scope = `${ownerUserId || 'anonymous'}:${chatId || 'no-chat'}:`;
  const id = artifactIdFor(Buffer.concat([Buffer.from(clean), buf]), scope);
  const ext = path.extname(clean).slice(1).toLowerCase() || 'bin';
  const stored = `${id}-${clean}`;
  const full = path.join(ARTIFACT_DIR, stored);
  fs.writeFileSync(full, buf);
  fs.writeFileSync(metadataPathFor(id), JSON.stringify({
    id,
    filename: clean,
    ownerUserId: ownerUserId || null,
    chatId: chatId || null,
    mime: mime || EXTENSION_TO_MIME[ext] || 'application/octet-stream',
    sizeBytes: buf.length,
    validation: validation || null,
    createdAt: new Date().toISOString(),
  }, null, 2));
  return {
    id,
    filename: clean,
    mime: mime || EXTENSION_TO_MIME[ext] || 'application/octet-stream',
    sizeBytes: buf.length,
    path: full,
    downloadUrl: `/api/agent/artifact/${id}?name=${encodeURIComponent(clean)}`,
  };
}

function validateAgentArtifactBuffer(ext, buffer) {
  const normalizedExt = ext === 'markdown' ? 'md' : String(ext || '').toLowerCase();
  if (ADVANCED_DOCUMENT_FORMATS.has(normalizedExt)) {
    return validateDocument({
      format: normalizedExt,
      buffer,
      expected: normalizedExt === 'csv' ? { minRows: 2, minColumns: 2, minChars: 20 } : {},
    });
  }

  const text = buffer.toString('utf8');
  if (normalizedExt === 'svg') {
    const checks = {
      notEmpty: buffer.length > 60,
      svgOpen: /<svg[\s>]/i.test(text),
      svgClose: /<\/svg>/i.test(text),
      noScript: !/<script[\s>]/i.test(text),
    };
    const score = Math.round((Object.values(checks).filter(Boolean).length / Object.values(checks).length) * 100);
    return { format: 'svg', checks, technicalScore: score, qualityScore: score, integrityScore: Math.min(100, Math.round(buffer.length / 100)), overallScore: score, passed: score >= 90 };
  }

  if (normalizedExt === 'json') {
    try {
      JSON.parse(text);
      return { format: 'json', checks: { parseable: true, notEmpty: buffer.length > 2 }, technicalScore: 100, qualityScore: 90, integrityScore: 90, overallScore: 96, passed: true };
    } catch (err) {
      return { format: 'json', checks: { parseable: false, notEmpty: buffer.length > 2 }, technicalScore: 50, qualityScore: 40, integrityScore: 50, overallScore: 47, passed: false, details: { error: err.message } };
    }
  }

  const checks = { notEmpty: buffer.length > 20, readable: /\S/.test(text), lineCount: text.split(/\r?\n/).length >= 1 };
  const score = Math.round((Object.values(checks).filter(Boolean).length / Object.values(checks).length) * 100);
  return { format: normalizedExt || 'bin', checks, technicalScore: score, qualityScore: score, integrityScore: Math.min(100, Math.round(buffer.length / 100)), overallScore: score, passed: score >= 80 };
}

function assertArtifactValidation(ext, buffer) {
  const validation = validateAgentArtifactBuffer(ext, buffer);
  if (!validation.passed || validation.technicalScore < MIN_TECHNICAL_SCORE || validation.qualityScore < MIN_QUALITY_SCORE) {
    const err = new Error(`artifact validation failed: technical ${validation.technicalScore}/100, quality ${validation.qualityScore}/100`);
    err.validation = validation;
    throw err;
  }
  return validation;
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
      signal: ctx.signal,
    });
    const payload = {
      ok: r.ok,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      timedOut: r.timedOut,
      aborted: r.aborted,
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
    const r = await sandbox.run({ language: 'javascript', source, timeoutMs: timeoutMs || 8000, signal: ctx.signal });
    const payload = {
      ok: r.ok, exitCode: r.exitCode, durationMs: r.durationMs, timedOut: r.timedOut, aborted: r.aborted,
      stdout: previewText(r.stdout || '', 4000), stderr: previewText(r.stderr || '', 2000),
    };
    ctx.onEvent?.({ type: 'tool_output', tool: 'bash_exec', ok: r.ok, preview: payload.ok ? previewText(r.stdout || '', 600) : previewText(r.stderr || '', 600) });
    return payload;
  },
};

// ─── Tool 3: web_search (agentic multi-provider) ────────────────────────

const webSearch = {
  name: 'web_search',
  description: 'Run the agentic multi-provider search (Web of Science + Scopus + OpenAlex + SciELO + Semantic Scholar + Crossref + PubMed + DOAJ). Returns a compact list of top sources with title, authors, year, journal, doi, url. Use when the user asks for real citations, fresh data, or academic references.',
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
      signal: ctx.signal,
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
    let validation;
    try {
      validation = assertArtifactValidation(ext, raw);
    } catch (err) {
      try { fs.unlinkSync(tmpOut); } catch { /* best effort */ }
      const payload = {
        ok: false,
        error: err.message || 'artifact validation failed',
        validation: err.validation || null,
        stderr: previewText(r.stderr || '', 1200),
        stdout: previewText(r.stdout || '', 600),
      };
      ctx.onEvent?.({
        type: 'tool_output',
        tool: 'create_document',
        ok: false,
        preview: `${payload.error}. Regenera el archivo con estructura profesional y vuelve a verificar.`,
      });
      return payload;
    }
    const b64 = raw.toString('base64');
    const artifact = saveArtifact({
      filename: cleanName,
      base64: b64,
      mime: EXTENSION_TO_MIME[ext],
      ownerUserId: ctx.userId,
      chatId: ctx.chatId,
      validation,
    });
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
      id: artifact.id,
      artifactId: artifact.id,
      filename: artifact.filename,
      sizeBytes: artifact.sizeBytes,
      mime: artifact.mime,
      downloadUrl: artifact.downloadUrl,
      validation,
      stdout: previewText(r.stdout || '', 1200),
    };
  },
};

// ─── Tool 5: read_skill_file (RAG read) ─────────────────────────────────

const ragRetrieve = {
  name: 'rag_retrieve',
  description: 'Retrieve up to K chunks from the user\'s private knowledge collection using the production RAG stack (query expansion + hybrid BM25/vector + MMR + graph expansion when indexed). Use when the user refers to uploaded docs, project files, PDFs, or says "según mis archivos".',
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
      const hits = await rag.retrieve(ctx.userId, collection || ctx.collection || 'default', query, k, {
        useExpansion: true,
        useHybrid: true,
        useMMR: true,
        useGraph: true,
        graphOpenAI: ctx.openai || rag.getOpenAI(),
        sessionId: ctx.chatId || null,
      });
      ctx.onEvent?.({ type: 'tool_output', tool: 'rag_retrieve', ok: true, preview: `${hits?.length || 0} chunks` });
      return { ok: true, hits };
    } catch (err) {
      ctx.onEvent?.({ type: 'tool_output', tool: 'rag_retrieve', ok: false, preview: err.message });
      return { ok: false, error: err.message };
    }
  },
};

// ─── Tool 6: verify_artifact (self-supervision) ─────────────────────────
//
// Reads an artifact the agent just created back from disk and returns
// a structured summary (sheet names, row counts, column headers,
// paragraph counts, byte size). The agent uses this to close the
// "did I actually deliver what the user asked for?" loop without the
// user having to download the file and report back.
//
// Format-specific summaries:
//   .xlsx → list of (sheet, rows, columns, headers[])
//   .docx → paragraph count + first-N paragraph previews
//   .csv  → first row, total rows, columns
//   .json → top-level keys + element count if array
//   .txt  → line count + first/last lines
//   anything else → byte size only
//
// Implemented as a Python snippet executed in the same sandbox as
// python_exec — that way we don't add new top-level deps and the
// detector code lives next to the writer code.

const verifyArtifact = {
  name: 'verify_artifact',
  description: 'Read an artifact you just created back from disk and return a structured summary (sheet/row counts for xlsx, paragraph counts for docx, line/row counts for csv/txt, key list for json). Call this AFTER create_document to confirm the file actually contains what the user asked for. If verification reveals a gap (wrong row count, missing column, empty sheet), call create_document again with a corrected script.',
  parameters: {
    type: 'object',
    properties: {
      artifactId: { type: 'string', description: 'The id from a previous file_artifact event (e.g. the `id` field in the create_document result).' },
    },
    required: ['artifactId'],
    additionalProperties: false,
  },
  async execute({ artifactId }, ctx = {}) {
    ctx.onEvent?.({ type: 'tool_call', tool: 'verify_artifact', preview: `verificando ${artifactId}` });
    const id = String(artifactId || '').replace(/[^a-f0-9]/gi, '');
    if (!id) {
      ctx.onEvent?.({ type: 'tool_output', tool: 'verify_artifact', ok: false, preview: 'invalid artifact id' });
      return { ok: false, error: 'invalid artifact id' };
    }
    if (!fs.existsSync(ARTIFACT_DIR)) {
      ctx.onEvent?.({ type: 'tool_output', tool: 'verify_artifact', ok: false, preview: 'no artifacts dir' });
      return { ok: false, error: 'no artifacts directory yet' };
    }
    const entry = fs.readdirSync(ARTIFACT_DIR).find(f => f.startsWith(`${id}-`));
    if (!entry) {
      ctx.onEvent?.({ type: 'tool_output', tool: 'verify_artifact', ok: false, preview: 'artifact not found' });
      return { ok: false, error: `artifact ${id} not found` };
    }
    let metadata = null;
    try {
      const metadataPath = metadataPathFor(id);
      if (fs.existsSync(metadataPath)) metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    } catch { /* metadata is auxiliary */ }
    const full = path.join(ARTIFACT_DIR, entry);
    const ext = path.extname(entry).slice(1).toLowerCase();
    const sizeBytes = fs.statSync(full).size;

    // Stdlib-only Python: openpyxl/python-docx might be missing in
    // some environments; we degrade gracefully and still return
    // size + extension so the agent at least confirms the file exists.
    const py = `
import sys, json, os
path = ${JSON.stringify(full)}
ext = ${JSON.stringify(ext)}
result = {"ok": True, "ext": ext, "sizeBytes": os.path.getsize(path)}
try:
    if ext == "xlsx":
        try:
            import openpyxl
            wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
            sheets = []
            for name in wb.sheetnames:
                ws = wb[name]
                # max_row/max_column include trailing empties; they're
                # still the truth the user cares about ("how many rows
                # are in my Excel right now").
                rows = ws.max_row or 0
                cols = ws.max_column or 0
                headers = []
                if rows > 0 and cols > 0:
                    for c in range(1, min(cols, 30) + 1):
                        v = ws.cell(row=1, column=c).value
                        headers.append(None if v is None else str(v))
                sheets.append({"name": name, "rows": rows, "columns": cols, "headers": headers})
            result["sheets"] = sheets
            result["totalRows"] = sum(s["rows"] for s in sheets)
        except ImportError as e:
            result["warning"] = f"openpyxl not installed ({e}); reported size only"
    elif ext == "docx":
        try:
            from docx import Document
            doc = Document(path)
            paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]
            result["paragraphCount"] = len(paragraphs)
            result["firstParagraphs"] = paragraphs[:5]
        except ImportError as e:
            result["warning"] = f"python-docx not installed ({e}); reported size only"
    elif ext == "pptx":
        try:
            from pptx import Presentation
            prs = Presentation(path)
            slides = []
            for i, slide in enumerate(prs.slides, 1):
                texts = []
                for shape in slide.shapes:
                    if shape.has_text_frame:
                        for para in shape.text_frame.paragraphs:
                            t = "".join(run.text for run in para.runs).strip()
                            if t: texts.append(t)
                slides.append({"slide": i, "textPreview": texts[:3]})
            result["slideCount"] = len(slides)
            result["slides"] = slides[:10]
        except ImportError as e:
            result["warning"] = f"python-pptx not installed ({e}); reported size only"
    elif ext == "csv":
        with open(path, encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
        result["lineCount"] = len(lines)
        if lines:
            header = lines[0].rstrip("\\n").split(",")
            result["columns"] = header
            result["firstDataRow"] = lines[1].rstrip("\\n") if len(lines) > 1 else None
    elif ext == "json":
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            result["arrayLength"] = len(data)
            result["firstItem"] = data[0] if data else None
        elif isinstance(data, dict):
            result["topLevelKeys"] = list(data.keys())[:50]
        else:
            result["scalar"] = repr(data)[:200]
    elif ext in ("txt", "md", "svg"):
        with open(path, encoding="utf-8", errors="replace") as f:
            text = f.read()
        result["charCount"] = len(text)
        result["lineCount"] = text.count("\\n") + 1
        result["firstChars"] = text[:240]
    elif ext == "pdf":
        try:
            import pypdf
            reader = pypdf.PdfReader(path)
            result["pageCount"] = len(reader.pages)
        except ImportError as e:
            result["warning"] = f"pypdf not installed ({e}); reported size only"
    else:
        result["warning"] = f"no specialised verifier for .{ext} — reported size only"
except Exception as e:
    result = {"ok": False, "error": str(e), "ext": ext, "sizeBytes": os.path.getsize(path)}
print(json.dumps(result))
`;
    const r = await sandbox.run({ language: 'python', source: py, timeoutMs: 12000, signal: ctx.signal });
    let summary;
    try {
      summary = JSON.parse((r.stdout || '').trim().split('\n').filter(Boolean).pop() || '{}');
    } catch {
      summary = { ok: false, error: 'verifier output was not valid JSON', stdout: previewText(r.stdout || '', 600), stderr: previewText(r.stderr || '', 600) };
    }
    summary.sizeBytes = summary.sizeBytes || sizeBytes;
    summary.filename = entry.slice(id.length + 1);
    summary.artifactId = id;
    summary.validation = metadata?.validation || null;
    ctx.onEvent?.({
      type: 'tool_output',
      tool: 'verify_artifact',
      ok: Boolean(summary.ok),
      preview: summarisePreview(summary),
    });
    return summary;
  },
};

function summarisePreview(s) {
  if (!s) return 'sin datos';
  const parts = [];
  if (s.ext) parts.push(`.${s.ext}`);
  if (typeof s.sizeBytes === 'number') parts.push(`${Math.max(1, Math.round(s.sizeBytes / 1024))} KB`);
  if (Array.isArray(s.sheets)) parts.push(`${s.sheets.length} hojas, ${s.totalRows ?? 0} filas`);
  if (typeof s.paragraphCount === 'number') parts.push(`${s.paragraphCount} párrafos`);
  if (typeof s.slideCount === 'number') parts.push(`${s.slideCount} diapositivas`);
  if (typeof s.lineCount === 'number') parts.push(`${s.lineCount} líneas`);
  if (typeof s.pageCount === 'number') parts.push(`${s.pageCount} páginas`);
  if (Array.isArray(s.columns)) parts.push(`${s.columns.length} columnas`);
  if (s.warning) parts.push(`⚠ ${s.warning}`);
  if (s.error) parts.push(`✗ ${s.error}`);
  return parts.join(' · ');
}

// ─── Tool 7: run_tests (auto-test for generated code) ───────────────────
//
// Closes the "corre tests por sí solo" loop. The agent writes a
// solution + a tiny test_source that calls _check(name, cond, detail).
// The harness counts passed/failed and surfaces failure details so
// the agent can repair before finalize. Same sandbox + timeouts as
// python_exec — no network, fresh temp dir, kill on overrun.
//
// Convention: tests use the helper _check(name, condition, detail).
// Example for python:
//   _check('add 1+1', solution.add(1, 1) == 2)
//   _check('handles negatives', solution.add(-3, 5) == 2, detail='wanted 2')

const runTests = {
  name: 'run_tests',
  description: 'Run unit tests against a code solution in the sandbox. Use after generating a function/module to verify it actually works before finalize. The harness exposes a `_check(name, condition, detail)` helper. Returns passed/failed counts and per-failure details so you can iterate.',
  parameters: {
    type: 'object',
    properties: {
      language: { type: 'string', enum: ['python', 'javascript', 'node'], description: 'Language of both solution and tests.' },
      source:   { type: 'string', description: 'The solution code (functions/classes to test).' },
      testSource: { type: 'string', description: 'Test code that calls _check(name, condition, detail). Multi-line allowed.' },
      timeoutMs: { type: 'integer', minimum: 500, maximum: 60000, description: 'Wall-clock timeout in ms (default 10000).' },
    },
    required: ['language', 'source', 'testSource'],
    additionalProperties: false,
  },
  async execute({ language, source, testSource, timeoutMs }, ctx = {}) {
    ctx.onEvent?.({
      type: 'tool_call',
      tool: 'run_tests',
      preview: previewText(testSource, 240),
      language,
      codePreview: previewText(`# solution\n${source}\n\n# tests\n${testSource}`, 600),
    });
    const r = await sandbox.runTests({
      language,
      source,
      testSource,
      timeoutMs: timeoutMs || 10000,
      signal: ctx.signal,
    });
    const summary = `${r.passed}✓ / ${r.failed}✗${r.timedOut ? ' (timeout)' : ''}`;
    ctx.onEvent?.({
      type: 'tool_output',
      tool: 'run_tests',
      ok: r.ok,
      preview: r.failures.length === 0
        ? summary
        : `${summary} · primer fallo: ${previewText(r.failures[0].detail || r.failures[0].name, 300)}`,
    });
    return {
      ok: r.ok,
      passed: r.passed,
      failed: r.failed,
      timedOut: r.timedOut,
      durationMs: r.durationMs,
      failures: (r.failures || []).slice(0, 10),
      stdout: previewText(r.stdout || '', 1200),
      stderr: previewText(r.stderr || '', 800),
    };
  },
};

// ─── Assembly ──────────────────────────────────────────────────────────

/**
 * @returns {Array<object>} the tools array to pass into react-agent's
 * `tools` parameter.
 */
function buildTaskTools() {
  return [pythonExec, bashExec, webSearch, createDocument, ragRetrieve, verifyArtifact, runTests];
}

module.exports = {
  buildTaskTools,
  saveArtifact,
  ARTIFACT_DIR,
  EXTENSION_TO_MIME,
  INTERNAL: { pythonExec, bashExec, webSearch, createDocument, ragRetrieve, verifyArtifact, runTests, previewText, artifactIdFor, metadataPathFor, summarisePreview, validateAgentArtifactBuffer, assertArtifactValidation },
};
