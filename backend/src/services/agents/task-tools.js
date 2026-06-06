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
const { writeJsonAtomicSync } = require('../../utils/atomic-json-write');
const crypto = require('crypto');
const objectStorage = require('../object-storage');
const sandbox = require('./code-sandbox');
const {
  MIN_QUALITY_SCORE,
  MIN_TECHNICAL_SCORE,
  validateDocument,
} = require('../document-pipeline/advanced-document-pipeline');
const documentIntelligence = require('../document-intelligence');

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
  html: 'text/html',
  htm:  'text/html',
  xml:  'application/xml',
  yaml: 'application/yaml',
  yml:  'application/yaml',
  png:  'image/png',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  gif:  'image/gif',
  webp: 'image/webp',
  ico:  'image/x-icon',
  mp4:  'video/mp4',
  webm: 'video/webm',
  mp3:  'audio/mpeg',
  wav:  'audio/wav',
  zip:  'application/zip',
};

const ADVANCED_DOCUMENT_FORMATS = new Set(['docx', 'xlsx', 'pptx', 'pdf', 'csv', 'html', 'md']);

const ACTIVE_TEXT_ARTIFACT_EXTENSIONS = new Set(['html', 'htm', 'svg', 'json']);
const ACTIVE_TEXT_ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;

const DANGEROUS_ARTIFACT_EXTENSIONS = new Set([
  'app', 'apk', 'bat', 'cmd', 'com', 'cpl', 'dll', 'dmg', 'exe', 'gadget',
  'hta', 'jar', 'js', 'jse', 'lnk', 'mjs', 'msi', 'msp', 'pif', 'ps1',
  'psm1', 'scr', 'sh', 'vb', 'vbe', 'vbs', 'ws', 'wsc', 'wsf', 'wsh',
]);

function metadataPathFor(id) {
  return path.join(ARTIFACT_DIR, `${id}.json`);
}

// R2 object key mirroring an artifact's on-disk relative path. Keeping the
// path shape ("agent-artifacts/<storedRelPath>") makes the bucket layout
// self-describing and lets the serving route reconstruct the key from
// metadata alone.
function artifactBinaryKey(storedRelPath) {
  return `agent-artifacts/${String(storedRelPath).split(path.sep).join('/')}`;
}

// Best-effort offload of a freshly written artifact binary to R2, then drop
// the local copy so the VM disk stays small. Fire-and-forget: saveArtifact
// stays synchronous (it has many sync callers) while the upload happens in
// the background. The local file keeps serving downloads until the upload
// confirms; only then is it unlinked. The serving route falls back to R2
// once the local binary is gone. The metadata JSON is intentionally NOT
// uploaded/removed — it is tiny text and is required on disk by the artifact
// listing scans.
function startArtifactMirror({ id, full, storedRelPath, mime }) {
  const key = artifactBinaryKey(storedRelPath);
  (async () => {
    try {
      const buf = await fs.promises.readFile(full);
      await objectStorage.putBuffer({ key, buffer: buf, contentType: mime || 'application/octet-stream' });
      try { await fs.promises.unlink(full); } catch { /* best effort cleanup */ }
    } catch (err) {
      console.warn(`[task-tools] R2 artifact mirror failed for ${id}: ${err && err.message}`);
    }
  })();
}

function sanitizeArtifactFilename(filename) {
  // Replace unsafe chars, then cap total length to 120 while preserving
  // the extension. A naive slice(0, 120) on a long name would drop the
  // extension and break MIME inference downstream.
  let sanitized = String(filename || 'artifact').replace(/[^a-zA-Z0-9._-]/g, '_') || 'artifact';
  const extName = path.extname(sanitized).slice(1).toLowerCase();
  if (DANGEROUS_ARTIFACT_EXTENSIONS.has(extName)) {
    sanitized += '.txt';
  }
  if (sanitized.length <= 120) return sanitized;
  const ext = path.extname(sanitized);
  if (!ext || ext.length >= 120) return sanitized.slice(0, 120);
  const base = sanitized.slice(0, sanitized.length - ext.length);
  const keep = Math.max(1, 120 - ext.length);
  return base.slice(0, keep) + ext;
}

function assertArtifactSizeWithinLimit(ext, buffer) {
  const normalizedExt = String(ext || '').toLowerCase();
  if (!ACTIVE_TEXT_ARTIFACT_EXTENSIONS.has(normalizedExt)) return;
  if (buffer.length <= ACTIVE_TEXT_ARTIFACT_MAX_BYTES) return;

  const limitMb = (ACTIVE_TEXT_ARTIFACT_MAX_BYTES / (1024 * 1024)).toFixed(0);
  const actualKb = Math.ceil(buffer.length / 1024);
  const err = new Error(`artifact size limit exceeded for ${normalizedExt}: ${actualKb} KB > ${limitMb} MB`);
  err.code = 'ARTIFACT_SIZE_LIMIT_EXCEEDED';
  err.format = normalizedExt;
  err.sizeBytes = buffer.length;
  err.maxBytes = ACTIVE_TEXT_ARTIFACT_MAX_BYTES;
  throw err;
}

// Defensive re-sanitisation of a folder code at the storage boundary. The
// professional-document-cycle service already sanitises it before enqueue,
// but we never trust a value that becomes a filesystem path. Returns null on
// any problem so callers fall back to the flat artifact dir.
function safeFolderCode(folderCode) {
  if (!folderCode) return null;
  try {
    const { sanitizeFolderCode } = require('./professional-document-cycle');
    return sanitizeFolderCode(folderCode);
  } catch {
    // Fallback sanitiser if the service is unavailable (or input invalid).
    const cleaned = String(folderCode)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9 _-]+/g, '_')
      .replace(/\s+/g, '-')
      .replace(/^[-_.]+/, '')
      .replace(/[-_.]+$/, '')
      .slice(0, 80);
    return cleaned || null;
  }
}

function saveArtifact({ filename, base64, mime, ownerUserId, chatId, validation, category, folderCode }) {
  try {
    const { requireDurableArtifactStorage } = require('../../orchestration/artifact-storage-policy');
    const policy = requireDurableArtifactStorage();
    if (!policy.ok && process.env.NODE_ENV === 'production') {
      console.warn('[task-tools] artifact storage policy:', policy.error);
    }
  } catch { /* policy module optional in tests */ }
  ensureArtifactDir();
  const clean = sanitizeArtifactFilename(filename);
  const buf = Buffer.from(base64 || '', 'base64');
  const ext = path.extname(clean).slice(1).toLowerCase() || 'bin';
  assertArtifactSizeWithinLimit(ext, buf);
  const scope = `${ownerUserId || 'anonymous'}:${chatId || 'no-chat'}:`;
  const id = artifactIdFor(Buffer.concat([Buffer.from(clean), buf]), scope);
  const stored = `${id}-${clean}`;
  // When a folder code is supplied (professional document cycle) the binary
  // is grouped under ARTIFACT_DIR/<safeCode>/. The metadata JSON stays FLAT
  // at ARTIFACT_DIR/<id>.json so readArtifactMetadata + listArtifactsByOwner
  // keep working unchanged; `storedRelPath` records the real location.
  const safeFolder = safeFolderCode(folderCode);
  const targetDir = safeFolder ? path.join(ARTIFACT_DIR, safeFolder) : ARTIFACT_DIR;
  if (safeFolder && !fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  const full = path.join(targetDir, stored);
  const storedRelPath = safeFolder ? path.posix.join(safeFolder, stored) : stored;
  fs.writeFileSync(full, buf);
  const resolvedMime = mime || EXTENSION_TO_MIME[ext] || 'application/octet-stream';
  // When R2 is enabled the binary is offloaded off the VM disk; record the
  // deterministic R2 ref in metadata so the serving route can stream it once
  // the local copy is gone. The key is derived purely from storedRelPath so
  // we can compute it before the (async) upload starts.
  const storageRef = objectStorage.enabled()
    ? objectStorage.refFromKey(artifactBinaryKey(storedRelPath))
    : null;
  try {
    writeJsonAtomicSync(metadataPathFor(id), {
      id,
      filename: clean,
      format: ext,
      ownerUserId: ownerUserId || null,
      chatId: chatId || null,
      mime: resolvedMime,
      sizeBytes: buf.length,
      validation: validation || null,
      category: category || null,
      folderCode: safeFolder || null,
      storedRelPath,
      storageRef,
      createdAt: new Date().toISOString(),
    }, { pretty: 2 });
  } catch (err) {
    // Remove the orphan artifact so subsequent listings don't show a
    // file the system has no record of. Re-throw so the caller knows
    // the save failed atomically.
    try { fs.unlinkSync(full); } catch { /* best effort */ }
    throw err;
  }
  // Kick off the R2 offload only after metadata is durably written, so a
  // metadata failure can't leave an orphan object in the bucket.
  if (storageRef) {
    startArtifactMirror({ id, full, storedRelPath, mime: resolvedMime });
  }
  return {
    id,
    filename: clean,
    format: ext,
    mime: resolvedMime,
    sizeBytes: buf.length,
    path: full,
    folderCode: safeFolder || null,
    storedRelPath,
    storageRef,
    downloadUrl: `/api/agent/artifact/${id}?name=${encodeURIComponent(clean)}`,
  };
}

// Magic-byte signatures for binary formats. The default text validator
// would otherwise report a 100% pass for any non-empty image just
// because /\S/ matches gibberish bytes. Each entry is [extension, [bytes
// matching at offset 0]]. PDF "%" + "PDF-" we anchor at offset 0.
const BINARY_MAGIC_SIGNATURES = {
  png:  [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  jpg:  [[0xff, 0xd8, 0xff]],
  jpeg: [[0xff, 0xd8, 0xff]],
  gif:  [[0x47, 0x49, 0x46, 0x38, 0x37, 0x61], [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
  webp: [[0x52, 0x49, 0x46, 0x46]], // RIFF; full check requires WEBP at offset 8
};

function bufferHasMagic(buffer, ext) {
  const sigs = BINARY_MAGIC_SIGNATURES[ext];
  if (!sigs) return null;
  for (const sig of sigs) {
    if (buffer.length < sig.length) continue;
    let ok = true;
    for (let i = 0; i < sig.length; i++) {
      if (buffer[i] !== sig[i]) { ok = false; break; }
    }
    if (ok) {
      // Extra check for webp: bytes 8-11 must equal "WEBP".
      if (ext === 'webp') {
        if (buffer.length < 12 || buffer[8] !== 0x57 || buffer[9] !== 0x45 || buffer[10] !== 0x42 || buffer[11] !== 0x50) continue;
      }
      return true;
    }
  }
  return false;
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

  // Binary formats: validate the file-magic header, not utf-8 substance.
  if (BINARY_MAGIC_SIGNATURES[normalizedExt]) {
    const magicOk = bufferHasMagic(buffer, normalizedExt);
    const checks = {
      notEmpty: buffer.length > 32,
      validMagic: Boolean(magicOk),
    };
    const score = Math.round((Object.values(checks).filter(Boolean).length / Object.values(checks).length) * 100);
    return {
      format: normalizedExt,
      checks,
      technicalScore: score,
      qualityScore: score,
      integrityScore: Math.min(100, Math.round(buffer.length / 1024)),
      overallScore: score,
      passed: score === 100,
    };
  }

  const text = buffer.toString('utf8');
  if (normalizedExt === 'svg') {
    // Beyond <script>, the common SVG XSS vectors are inline event
    // handlers (onload/onerror/etc) and javascript: hrefs. Flag those
    // so a "valid SVG" with active content doesn't sneak past.
    const checks = {
      notEmpty: buffer.length > 60,
      svgOpen: /<svg[\s>]/i.test(text),
      svgClose: /<\/svg>/i.test(text),
      noScript: !/<script[\s>]/i.test(text),
      noEventHandlers: !/\son(?:load|error|click|mouseover|mouseout|focus|blur|keydown|keyup)\s*=/i.test(text),
      noJavascriptHref: !/(?:href|xlink:href)\s*=\s*["']?\s*javascript:/i.test(text),
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

// Clamp a numeric timeout into a [min, max] range with a default
// fallback when the input is missing / non-finite. Enforced at the
// tool boundary so the schema bounds are respected even when callers
// bypass JSON-schema validation.
function clampTimeoutMs(input, { min, max, defaultMs }) {
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) return defaultMs;
  return Math.max(min, Math.min(n, max));
}

// Clamp a positive integer input into [min, max] with a default. Used
// for tool-level guards on schema-bounded fields (webSearch topK/target).
function clampInt(input, { min, max, defaultValue }) {
  const n = Math.floor(Number(input));
  if (!Number.isFinite(n) || n <= 0) return defaultValue;
  return Math.max(min, Math.min(n, max));
}

function previewText(s, max = 600) {
  // Guard against callers passing a non-positive or non-finite max
  // (e.g., NaN from a failed Number() coercion). Without this, the
  // slice below would either return an empty string or throw.
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 600;
  max = limit;
  if (typeof s !== 'string') {
    // JSON.stringify throws on circular refs and returns undefined for
    // bigint/symbol/function values. Guard so a single malformed payload
    // can't crash the agent's preview emission.
    try {
      const stringified = JSON.stringify(s);
      s = typeof stringified === 'string' ? stringified : String(s);
    } catch {
      s = String(s);
    }
  }
  if (s.length <= max) return s;
  // String#slice on UTF-16 code units can leave a high-surrogate
  // dangling at the cut, producing an invalid string that crashes
  // downstream JSON serialisers. Pull the cut back by one if the last
  // kept code unit is a high surrogate.
  let cut = max;
  const code = s.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return s.slice(0, cut) + `…  (+${s.length - cut} chars truncated)`;
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
    if (typeof source !== 'string' || !source.trim()) {
      ctx.onEvent?.({ type: 'tool_output', tool: 'python_exec', ok: false, preview: 'empty source' });
      return { ok: false, error: 'python_exec requires a non-empty "source" string' };
    }
    ctx.onEvent?.({ type: 'tool_call', tool: 'python_exec', preview: previewText(source, 400), language: 'python' });
    ctx.onEvent?.({ type: 'stage', label: 'Ejecutando código Python', pct: 20 });
    const r = await sandbox.run({
      language: 'python',
      source,
      timeoutMs: clampTimeoutMs(timeoutMs, { min: 500, max: 60000, defaultMs: 10000 }),
      stdin: stdin || '',
      signal: ctx.signal,
    });
    const rawStdout = r.stdout || '';
    const rawStderr = r.stderr || '';
    const payload = {
      ok: r.ok,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      timedOut: r.timedOut,
      aborted: r.aborted,
      stdout: previewText(rawStdout, 4000),
      stderr: previewText(rawStderr, 2000),
      stdoutTruncated: rawStdout.length > 4000,
      stderrTruncated: rawStderr.length > 2000,
    };
    ctx.onEvent?.({ type: 'stage', label: 'Capturando salida', pct: 90 });
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
    if (typeof source !== 'string' || !source.trim()) {
      ctx.onEvent?.({ type: 'tool_output', tool: 'bash_exec', ok: false, preview: 'empty source' });
      return { ok: false, error: 'bash_exec requires a non-empty "source" string' };
    }
    ctx.onEvent?.({ type: 'tool_call', tool: 'bash_exec', preview: previewText(source, 400), language: 'javascript' });
    const r = await sandbox.run({
      language: 'javascript',
      source,
      timeoutMs: clampTimeoutMs(timeoutMs, { min: 500, max: 30000, defaultMs: 8000 }),
      signal: ctx.signal,
    });
    const rawStdout = r.stdout || '';
    const rawStderr = r.stderr || '';
    const payload = {
      ok: r.ok, exitCode: r.exitCode, durationMs: r.durationMs, timedOut: r.timedOut, aborted: r.aborted,
      stdout: previewText(rawStdout, 4000), stderr: previewText(rawStderr, 2000),
      stdoutTruncated: rawStdout.length > 4000,
      stderrTruncated: rawStderr.length > 2000,
    };
    ctx.onEvent?.({ type: 'tool_output', tool: 'bash_exec', ok: r.ok, preview: payload.ok ? previewText(rawStdout, 600) : previewText(rawStderr, 600) });
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
  async execute({ query, topK, target }, ctx = {}) {
    if (typeof query !== 'string' || !query.trim()) {
      ctx.onEvent?.({ type: 'tool_output', tool: 'web_search', ok: false, preview: 'empty query' });
      return { ok: false, error: 'web_search requires a non-empty "query"', sources: [] };
    }
    ctx.onEvent?.({ type: 'tool_call', tool: 'web_search', preview: query });
    const { runAgenticBatch } = getAgenticBatch();
    // Defense-in-depth: clamp into the schema bounds so a caller
    // bypassing JSON-schema validation can't ask for 0 or 5_000 sources.
    const safeTopK = clampInt(topK, { min: 5, max: 50, defaultValue: 15 });
    const safeTarget = clampInt(target, { min: 20, max: 500, defaultValue: 100 });
    let selected = [];
    let stats = null;
    try {
      for await (const evt of runAgenticBatch({
        query,
        target: safeTarget,
        batchSize: 10,
        topK: safeTopK,
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
      _preview: `${selected.length} fuentes top${stats?.dedupedCount ? ` (${stats.dedupedCount} recopiladas)` : ''}`,
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
    if (typeof filename !== 'string' || !filename.trim()) {
      ctx.onEvent?.({ type: 'tool_output', tool: 'create_document', ok: false, preview: 'missing filename' });
      return { ok: false, error: 'create_document requires a non-empty "filename"' };
    }
    if (typeof python !== 'string' || !python.trim()) {
      ctx.onEvent?.({ type: 'tool_output', tool: 'create_document', ok: false, preview: 'missing python source' });
      return { ok: false, error: 'create_document requires a non-empty "python" source string' };
    }
    ensureArtifactDir();
    const cleanName = sanitizeArtifactFilename(filename);
    // Date.now()+random suffix: two concurrent create_document calls on
    // the same ms timestamp would otherwise collide on tmpOut and one
    // would clobber the other's artifact mid-write.
    const tmpOut = path.join(ARTIFACT_DIR, `pending-${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${cleanName}`);
    const ext = path.extname(cleanName).slice(1).toLowerCase();

    ctx.onEvent?.({
      type: 'tool_call',
      tool: 'create_document',
      preview: description || `Generando ${cleanName}`,
      language: 'python',
      codePreview: previewText(python, 400),
    });
    ctx.onEvent?.({ type: 'stage', label: 'Preparando entorno Python', pct: 5 });

    // Inject OUT_PATH env into the script via os.environ before the
    // agent's code runs. Some models still save to a local filename
    // despite the contract; the recovery footer copies the newest
    // matching artifact into OUT_PATH so the task does not loop forever
    // on a valid-but-misplaced document.
    const recoveryPatterns = [
      cleanName,
      ext ? `*.${ext}` : '*',
      ext ? `**/*.${ext}` : '**/*',
    ];
    const wrapped = [
      'import os, glob, shutil',
      `os.environ["OUT_PATH"] = ${JSON.stringify(tmpOut)}`,
      'OUT_PATH = os.environ["OUT_PATH"]',
      python,
      '',
      '# -- siraGPT OUT_PATH recovery --',
      'if not os.path.exists(OUT_PATH):',
      `    _patterns = ${JSON.stringify(recoveryPatterns)}`,
      '    _candidates = []',
      '    for _pattern in _patterns:',
      '        _candidates.extend(glob.glob(_pattern, recursive=True))',
      '    _candidates = [p for p in _candidates if os.path.isfile(p) and os.path.abspath(p) != os.path.abspath(OUT_PATH)]',
      '    if _candidates:',
      '        _candidate = max(_candidates, key=lambda p: os.path.getmtime(p))',
      '        shutil.copyfile(_candidate, OUT_PATH)',
    ].join('\n');

    ctx.onEvent?.({ type: 'stage', label: 'Ejecutando script Python', pct: 15 });
    const r = await sandbox.run({
      language: 'python',
      source: wrapped,
      timeoutMs: clampTimeoutMs(timeoutMs, { min: 1000, max: 60000, defaultMs: 30000 }),
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

    ctx.onEvent?.({ type: 'stage', label: 'Procesando archivo generado', pct: 85 });
    const raw = fs.readFileSync(tmpOut);

    // Heuristic validation is now advisory: it runs, but it does NOT
    // short-circuit. The TaskContract deterministic tests are the
    // authoritative gate; without them we fall back to the heuristic
    // pass/fail, but we always collect the contract feedback first so
    // the agent's tool_result carries a concrete repair hint.
    let validation = null;
    let validationError = null;
    try {
      validation = assertArtifactValidation(ext, raw);
    } catch (err) {
      validation = err.validation || null;
      validationError = err.message || 'artifact validation failed';
    }

    const hasContract = ctx.taskContract && Array.isArray(ctx.taskContract.success_tests) && ctx.taskContract.success_tests.length > 0;
    if (!hasContract && validationError) {
      // Legacy path (no contract): keep the old hard-fail on heuristic.
      try { fs.unlinkSync(tmpOut); } catch { /* best effort */ }
      const payload = {
        ok: false,
        error: validationError,
        validation,
        stderr: previewText(r.stderr || '', 1200),
        stdout: previewText(r.stdout || '', 600),
      };
      ctx.onEvent?.({
        type: 'tool_output',
        tool: 'create_document',
        ok: false,
        preview: `${validationError}. Regenera el archivo con estructura profesional y vuelve a verificar.`,
      });
      return payload;
    }
    // TaskContract review: every produced artifact is tested against
    // the contract's deterministic success_tests. If any fail the
    // tool_result carries the failure list so the agent repairs before
    // finalize. Contract-failing files are NOT registered as downloadable
    // artifacts; this is the Format Sovereignty release gate.
    let contractReview = null;
    if (hasContract) {
      try {
        const { reviewArtifact } = require('./artifact-reviewer');
        contractReview = reviewArtifact({
          contract: ctx.taskContract,
          artifact: {
            filename: cleanName,
            buffer: raw,
          },
        });
        if (!contractReview.passed) {
          ctx.onEvent?.({
            type: 'contract_review',
            stepId: ctx.currentStepId,
            artifactId: null,
            passed: false,
            testsPassed: contractReview.testsPassed,
            testsTotal: contractReview.testsTotal,
            failedTests: contractReview.failedTests,
          });
        }
      } catch (revErr) {
        console.warn('[create_document] reviewer threw:', revErr?.message);
      }
    }

    if (contractReview && !contractReview.passed) {
      try { fs.unlinkSync(tmpOut); } catch { /* best effort */ }
      const repairHint = `Contract tests FAILED (${contractReview.failedTests.length}): ${contractReview.failedTests.map(f => `${f.id}: ${f.detail}`).join(' | ')}. Regenerate with a corrected script that satisfies every failed test before calling finalize.`;
      ctx.onEvent?.({
        type: 'tool_output',
        tool: 'create_document',
        ok: false,
        preview: `Archivo bloqueado por contrato ${contractReview.testsPassed}/${contractReview.testsTotal} ✗`,
      });
      return {
        ok: false,
        error: 'artifact blocked by Format Sovereignty Engine',
        validation,
        contractReview: {
          passed: false,
          testsTotal: contractReview.testsTotal,
          testsPassed: contractReview.testsPassed,
          failedTests: contractReview.failedTests,
          extDetected: contractReview.ext,
          mimeSniffed: contractReview.mimeSniffed,
        },
        failureReport: {
          failed_stage: 'format_validation',
          expected_output: ctx.taskContract?.required_extension ? `.${ctx.taskContract.required_extension}` : 'contract-compliant artifact',
          actual_output: `.${ext || 'unknown'}`,
          root_cause: contractReview.failedTests.map(f => `${f.id}: ${f.detail}`).join(' | '),
          repair_strategy: 'Regenerate the artifact with the exact required extension, MIME and structure from the contract.',
          retry_count: 0,
          tests_reexecuted: contractReview.tests.map(t => t.id),
          release_decision: 'blocked',
        },
        repairHint,
        stdout: previewText(r.stdout || '', 1200),
      };
    }

    const b64 = raw.toString('base64');
    const artifact = saveArtifact({
      filename: cleanName,
      base64: b64,
      mime: EXTENSION_TO_MIME[ext],
      ownerUserId: ctx.userId,
      chatId: ctx.chatId,
      validation: contractReview ? { ...validation, contractReview } : validation,
      folderCode: ctx.folderCode || null,
    });
    try { fs.unlinkSync(tmpOut); } catch { /* may have been moved */ }

    if (contractReview) {
      ctx.onEvent?.({
        type: 'contract_review',
        stepId: ctx.currentStepId,
        artifactId: artifact.id,
        passed: contractReview.passed,
        testsPassed: contractReview.testsPassed,
        testsTotal: contractReview.testsTotal,
        failedTests: contractReview.failedTests,
      });
    }

    ctx.onEvent?.({
      type: 'file_artifact',
      artifact: {
        id: artifact.id,
        filename: artifact.filename,
        format: artifact.format,
        mime: artifact.mime,
        sizeBytes: artifact.sizeBytes,
        downloadUrl: artifact.downloadUrl,
      },
    });

    const previewMsg = contractReview
      ? `Archivo ${artifact.filename} (${Math.round(artifact.sizeBytes / 1024)} KB) · contrato ${contractReview.testsPassed}/${contractReview.testsTotal}${contractReview.passed ? ' ✓' : ' ✗'}`
      : `Archivo listo: ${artifact.filename} (${Math.round(artifact.sizeBytes / 1024)} KB)`;

    ctx.onEvent?.({
      type: 'tool_output',
      tool: 'create_document',
      ok: !contractReview || contractReview.passed,
      preview: previewMsg,
    });

    return {
      ok: !contractReview || contractReview.passed,
      id: artifact.id,
      artifactId: artifact.id,
      filename: artifact.filename,
      format: artifact.format,
      sizeBytes: artifact.sizeBytes,
      mime: artifact.mime,
      downloadUrl: artifact.downloadUrl,
      validation,
      contractReview: contractReview ? {
        passed: contractReview.passed,
        testsTotal: contractReview.testsTotal,
        testsPassed: contractReview.testsPassed,
        failedTests: contractReview.failedTests,
        extDetected: contractReview.ext,
        mimeSniffed: contractReview.mimeSniffed,
      } : null,
      repairHint: contractReview && !contractReview.passed
        ? `Contract tests FAILED (${contractReview.failedTests.length}): ${contractReview.failedTests.map(f => `${f.id}: ${f.detail}`).join(' | ')}. Regenerate with a corrected script that satisfies every failed test before calling finalize.`
        : undefined,
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
  async execute({ query, k, collection }, ctx = {}) {
    if (!ctx.userId) {
      return { ok: false, error: 'rag_retrieve requires an authenticated userId in ctx' };
    }
    if (typeof query !== 'string' || !query.trim()) {
      return { ok: false, error: 'rag_retrieve requires a non-empty "query"' };
    }
    const safeK = clampInt(k, { min: 1, max: 20, defaultValue: 4 });
    ctx.onEvent?.({ type: 'tool_call', tool: 'rag_retrieve', preview: query });
    try {
      const rag = require('../rag-service');
      const hits = await rag.retrieve(ctx.userId, collection || ctx.collection || 'default', query, safeK, {
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

// ─── Tool 5b: self_rag_answer (Self-RAG critique loop) ─────────────────
//
// Wraps backend/src/services/rag/self-rag-engine.js (ICLR 2024
// Self-RAG: reflection-token gated retrieve → generate → critique).
// Where rag_retrieve gives the agent chunks to summarise freely,
// self_rag_answer produces the GROUNDED answer itself: for each
// segment the engine predicts a Retrieve/ISREL/ISSUP/ISUSE token,
// only supported segments survive, and beam selection picks the
// best-scored trajectory. Use this when the user asks a factual
// question against uploaded docs and we need citations + a
// "don't hallucinate" guarantee, not just the raw passages.

const selfRagAnswer = {
  name: 'self_rag_answer',
  description: "Answer a grounded question using the Self-RAG reflection-token loop (Asai et al. ICLR 2024). Produces the final answer directly with per-segment ISREL/ISSUP/ISUSE critique scores and citations. Prefer this over rag_retrieve when the user wants a concrete answer grounded on their uploaded PDFs/docs; use rag_retrieve when you only need raw chunks to combine with other data.",
  parameters: {
    type: 'object',
    properties: {
      question:     { type: 'string', description: 'The user question to answer. Keep it self-contained.' },
      k:            { type: 'integer', minimum: 1, maximum: 12, description: 'Passages per retrieve call (default 4).' },
      maxSegments:  { type: 'integer', minimum: 1, maximum: 10, description: 'Max answer segments before termination (default 4).' },
      retrieveMode: { type: 'string', enum: ['adaptive', 'always', 'never'], description: 'Retrieval gating. `adaptive` lets the engine decide; `always` forces retrieve every segment (strict grounding); `never` skips retrieval.' },
      hardConstraints: { type: 'boolean', description: 'If true, drop any segment whose ISSUP is not "fully supported" (stricter but may yield shorter answers).' },
      beamSize:     { type: 'integer', minimum: 1, maximum: 4, description: 'Tree-decoding beam width (default 1 = greedy).' },
      collection:   { type: 'string', description: 'RAG collection to query (defaults to the chat\'s default).' },
    },
    required: ['question'],
    additionalProperties: false,
  },
  async execute({ question, k, maxSegments, retrieveMode = 'adaptive', hardConstraints = false, beamSize, collection }, ctx = {}) {
    if (!ctx.userId) return { ok: false, error: 'self_rag_answer requires an authenticated userId in ctx' };
    if (typeof question !== 'string' || !question.trim()) {
      return { ok: false, error: 'self_rag_answer requires a non-empty "question"' };
    }
    const safeK = clampInt(k, { min: 1, max: 12, defaultValue: 4 });
    const safeMaxSegments = clampInt(maxSegments, { min: 1, max: 10, defaultValue: 4 });
    const safeBeamSize = clampInt(beamSize, { min: 1, max: 4, defaultValue: 1 });
    if (!ctx.openai) return { ok: false, error: 'self_rag_answer requires ctx.openai' };

    ctx.onEvent?.({ type: 'tool_call', tool: 'self_rag_answer', preview: previewText(question, 240) });

    let engine, rag;
    try {
      engine = require('../rag/self-rag-engine');
      rag = require('../rag-service');
    } catch (err) {
      ctx.onEvent?.({ type: 'tool_output', tool: 'self_rag_answer', ok: false, preview: `engine load failed: ${err.message}` });
      return { ok: false, error: err.message };
    }

    const retrieveFn = async (q, topK) => {
      try {
        const hits = await rag.retrieve(
          ctx.userId,
          collection || ctx.collection || 'default',
          q,
          topK,
          {
            useExpansion: true,
            useHybrid: true,
            useMMR: true,
            useGraph: true,
            graphOpenAI: ctx.openai,
            sessionId: ctx.chatId || null,
          }
        );
        return (Array.isArray(hits) ? hits : []).map((h, i) => ({
          id: h.id || `${i}`,
          text: h.text || h.content || h.chunk || '',
          source: h.source || h.metadata?.source || h.document || null,
        }));
      } catch (err) {
        console.warn('[self_rag_answer] retrieve failed:', err.message);
        return [];
      }
    };

    try {
      const runner = safeBeamSize > 1 ? engine.inferBeam : engine.infer;
      const out = await runner({
        openai: ctx.openai,
        input: question,
        retrieve: retrieveFn,
        k: safeK,
        model: 'gpt-4o-mini',
        retrieveMode,
        hardConstraints,
        maxSegments: safeMaxSegments,
        beamSize: safeBeamSize,
      });

      // Build the user-visible text from the engine's segments.
      // Every retrieved-and-supported segment becomes its own
      // paragraph with a trailing [N] citation; no-retrieve segments
      // (the engine's "didn't need grounding" path) stay plain text.
      const cites = [];
      const lines = (out.segments || []).map((s, i) => {
        const txt = (s.text || '').trim();
        if (!txt) return '';
        if (s.source && s.isSup && s.isSup !== 'no support') {
          const n = cites.length + 1;
          cites.push({ n, source: s.source, isRel: s.isRel, isSup: s.isSup, score: s.score });
          return `${txt} [${n}]`;
        }
        return txt;
      }).filter(Boolean);

      const answer = (out.answer && out.answer.trim()) || lines.join('\n\n');
      const references = cites.length
        ? '\n\n**Referencias**\n' + cites.map(c => `[${c.n}] ${c.source} · ISSUP=${c.isSup || '—'} · score ${typeof c.score === 'number' ? c.score.toFixed(2) : '—'}`).join('\n')
        : '';

      const supportedCount = (out.segments || []).filter(s => s.isSup && s.isSup !== 'no support').length;
      const totalCount = (out.segments || []).length;
      const summary = `${totalCount} segmentos, ${supportedCount} soportados, ${out.terminatedBy || '?'}`;

      ctx.onEvent?.({ type: 'tool_output', tool: 'self_rag_answer', ok: true, preview: summary });

      return {
        ok: true,
        answer: answer + references,
        summary,
        segments: (out.segments || []).map(s => ({
          index: s.index,
          text: previewText(s.text || '', 400),
          source: s.source,
          retrieveDecision: s.retrieveDecision,
          isRel: s.isRel,
          isSup: s.isSup,
          isUse: s.isUse,
          score: s.score,
        })),
        terminatedBy: out.terminatedBy,
        passagesSeen: (out.passagesSeen || []).length,
      };
    } catch (err) {
      ctx.onEvent?.({ type: 'tool_output', tool: 'self_rag_answer', ok: false, preview: err.message || 'self-rag failed' });
      return { ok: false, error: err.message || String(err) };
    }
  },
};

// ─── Tool 5c: Document Intelligence ────────────────────────────────────

const TOOL_FILE_ID_CAP = 12;

function resolveToolFileIds(inputFileIds, ctx = {}) {
  const ids = Array.isArray(inputFileIds) && inputFileIds.length
    ? inputFileIds
    : (Array.isArray(ctx.fileIds) ? ctx.fileIds : []);
  return Array.from(new Set(ids.map(String).filter(Boolean))).slice(0, TOOL_FILE_ID_CAP);
}

function describeFileIdTruncation(inputFileIds, ctx = {}) {
  const raw = Array.isArray(inputFileIds) && inputFileIds.length
    ? inputFileIds
    : (Array.isArray(ctx.fileIds) ? ctx.fileIds : []);
  const unique = Array.from(new Set(raw.map(String).filter(Boolean)));
  return {
    truncated: unique.length > TOOL_FILE_ID_CAP,
    requested: unique.length,
    used: Math.min(unique.length, TOOL_FILE_ID_CAP),
  };
}

function getPrismaForTool(ctx = {}) {
  if (ctx.prisma) return ctx.prisma;
  try { return require('../../config/database'); } catch { return null; }
}

const docintelAnalyze = {
  name: 'docintel_analyze',
  description: 'Analyze uploaded documents with the siraGPT Document Intelligence layer: MIME-aware text extraction, OCR evidence, structural chunks, table detection, and coverage. Use when the user says analiza, resume, transcribe, extrae, que dice, segun el documento, or asks about attached files.',
  parameters: {
    type: 'object',
    properties: {
      fileIds: { type: 'array', items: { type: 'string' }, description: 'File ids to analyze. Defaults to the current task attachments.' },
      force: { type: 'boolean', description: 'Force a fresh analysis even if one exists.' },
    },
    additionalProperties: false,
  },
  async execute({ fileIds = [], force = false } = {}, ctx = {}) {
    const prisma = getPrismaForTool(ctx);
    const ids = resolveToolFileIds(fileIds, ctx);
    ctx.onEvent?.({ type: 'tool_call', tool: 'docintel_analyze', preview: `${ids.length} archivo(s)` });
    if (!prisma || !ctx.userId) {
      return { ok: false, error: 'docintel_analyze requires prisma and authenticated userId' };
    }
    const analyses = [];
    const errors = [];
    for (const fileId of ids) {
      try {
        const analysis = await documentIntelligence.analyzeFile(prisma, {
          userId: ctx.userId,
          fileId,
          force,
        });
        analyses.push({
          id: analysis.id,
          fileId: analysis.fileId,
          status: analysis.status,
          summary: analysis.summary,
          charCount: analysis.charCount,
          chunkCount: analysis.chunkCount,
          tableCount: analysis.tableCount,
          textCoverage: analysis.textCoverage,
          warnings: analysis.warnings || [],
        });
      } catch (err) {
        // Per-file failures shouldn't poison the entire tool call —
        // surface them in the result so the agent can decide whether
        // to retry with `force: true` or skip the bad file.
        errors.push({ fileId, error: err?.message || String(err) });
      }
    }
    const truncation = describeFileIdTruncation(fileIds, ctx);
    ctx.onEvent?.({
      type: 'document_analysis',
      analysisIds: analyses.map((item) => item.id).filter(Boolean),
      evidenceRefs: analyses.map((item) => ({ analysisId: item.id, fileId: item.fileId, status: item.status })),
      summary: `${analyses.length} analisis documental(es)`,
    });
    const previewSuffix = errors.length ? ` (${errors.length} fallaron)` : '';
    ctx.onEvent?.({ type: 'tool_output', tool: 'docintel_analyze', ok: errors.length === 0, preview: `${analyses.length} analisis listo(s)${previewSuffix}` });
    return {
      ok: errors.length === 0,
      analyses,
      errors,
      truncation,
      _preview: `${analyses.length} documento(s) analizados${previewSuffix}`,
    };
  },
};

const docintelRetrieve = {
  name: 'docintel_retrieve',
  description: 'Retrieve grounded evidence chunks from analyzed documents. Returns text snippets with page/sheet/slide/section references. Use before answering factual questions about uploaded files.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Evidence query.' },
      fileIds: { type: 'array', items: { type: 'string' }, description: 'File ids. Defaults to current attachments.' },
      limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Max evidence chunks per file.' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async execute({ query, fileIds = [], limit }, ctx = {}) {
    const prisma = getPrismaForTool(ctx);
    if (typeof query !== 'string' || !query.trim()) {
      return { ok: false, error: 'docintel_retrieve requires a non-empty "query"' };
    }
    const safeLimit = clampInt(limit, { min: 1, max: 20, defaultValue: 8 });
    const ids = resolveToolFileIds(fileIds, ctx);
    ctx.onEvent?.({ type: 'tool_call', tool: 'docintel_retrieve', preview: previewText(query, 240) });
    if (!prisma || !ctx.userId) {
      return { ok: false, error: 'docintel_retrieve requires prisma and authenticated userId' };
    }
    const evidence = [];
    const analysisIds = [];
    for (const fileId of ids) {
      const analysis = await documentIntelligence.analyzeFile(prisma, {
        userId: ctx.userId,
        fileId,
      });
      if (analysis?.id) analysisIds.push(analysis.id);
      const result = await documentIntelligence.retrieveEvidence(prisma, {
        userId: ctx.userId,
        fileId,
        query,
        limit: safeLimit,
      });
      evidence.push(...(result.evidence || []));
    }
    const clipped = evidence.slice(0, safeLimit);
    ctx.onEvent?.({
      type: 'document_analysis',
      analysisIds,
      evidenceRefs: clipped.map((item) => ({
        analysisId: item.analysisId,
        chunkId: item.id,
        fileId: item.fileId,
        sourceLabel: item.sourceLabel,
      })),
      summary: `${clipped.length} evidencia(s) recuperada(s)`,
    });
    ctx.onEvent?.({ type: 'tool_output', tool: 'docintel_retrieve', ok: true, preview: `${clipped.length} fragmentos con evidencia` });
    return {
      ok: true,
      evidence: clipped.map((item) => ({
        id: item.id,
        fileId: item.fileId,
        analysisId: item.analysisId,
        sourceType: item.sourceType,
        sourceLabel: item.sourceLabel,
        pageNumber: item.pageNumber,
        sheetName: item.sheetName,
        slideNumber: item.slideNumber,
        sectionTitle: item.sectionTitle,
        text: previewText(item.text, 1800),
        score: item.score,
      })),
      truncation: describeFileIdTruncation(fileIds, ctx),
      _preview: `${clipped.length} fragmentos recuperados`,
    };
  },
};

const docintelExtractTables = {
  name: 'docintel_extract_tables',
  description: 'Return normalized tables detected in uploaded spreadsheets, CSV files, Word/PDF markdown tables, and document extracts. Use for KPI, tablas, calculos, datos, and Excel-style analysis.',
  parameters: {
    type: 'object',
    properties: {
      fileIds: { type: 'array', items: { type: 'string' }, description: 'File ids. Defaults to current attachments.' },
      limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Max tables to return.' },
    },
    additionalProperties: false,
  },
  async execute({ fileIds = [], limit } = {}, ctx = {}) {
    const prisma = getPrismaForTool(ctx);
    const ids = resolveToolFileIds(fileIds, ctx);
    const safeLimit = clampInt(limit, { min: 1, max: 20, defaultValue: 10 });
    ctx.onEvent?.({ type: 'tool_call', tool: 'docintel_extract_tables', preview: `${ids.length} archivo(s)` });
    if (!prisma || !ctx.userId) {
      return { ok: false, error: 'docintel_extract_tables requires prisma and authenticated userId' };
    }
    const tables = [];
    const errors = [];
    for (const fileId of ids) {
      try {
        await documentIntelligence.analyzeFile(prisma, { userId: ctx.userId, fileId });
        const fileTables = await documentIntelligence.getTablesForFile(prisma, { userId: ctx.userId, fileId });
        tables.push(...fileTables.map((table) => ({
          id: table.id,
          fileId: table.fileId,
          sourceType: table.sourceType,
          sourceLabel: table.sourceLabel,
          sheetName: table.sheetName,
          title: table.title,
          columns: table.columns,
          rowCount: table.rowCount,
          preview: table.preview,
        })));
      } catch (err) {
        errors.push({ fileId, error: err?.message || String(err) });
      }
    }
    const clipped = tables.slice(0, safeLimit);
    const previewSuffix = errors.length ? ` (${errors.length} fallaron)` : '';
    ctx.onEvent?.({ type: 'tool_output', tool: 'docintel_extract_tables', ok: errors.length === 0, preview: `${clipped.length} tabla(s)${previewSuffix}` });
    return {
      ok: errors.length === 0,
      tables: clipped,
      errors,
      truncation: describeFileIdTruncation(fileIds, ctx),
      _preview: `${clipped.length} tabla(s) normalizadas${previewSuffix}`,
    };
  },
};

const docintelCompare = {
  name: 'docintel_compare',
  description: 'Compare two or more uploaded documents or versions using Document Intelligence evidence, terms, counts, tables and warnings. Use when the user asks comparar, diferencias, cambios, versiones, similitudes, or cross-document analysis.',
  parameters: {
    type: 'object',
    properties: {
      fileIds: { type: 'array', items: { type: 'string' }, description: 'At least two file ids. Defaults to the current task attachments.' },
      query: { type: 'string', description: 'Optional focus for the comparison.' },
      limit: { type: 'integer', minimum: 1, maximum: 12, description: 'Evidence chunks per file.' },
    },
    additionalProperties: false,
  },
  async execute({ fileIds = [], query = '', limit } = {}, ctx = {}) {
    const prisma = getPrismaForTool(ctx);
    const ids = resolveToolFileIds(fileIds, ctx);
    const safeLimit = clampInt(limit, { min: 1, max: 12, defaultValue: 6 });
    ctx.onEvent?.({ type: 'tool_call', tool: 'docintel_compare', preview: `${ids.length} documento(s)` });
    if (!prisma || !ctx.userId) {
      return { ok: false, error: 'docintel_compare requires prisma and authenticated userId' };
    }
    if (ids.length < 2) {
      return { ok: false, error: 'docintel_compare requires at least two file ids' };
    }

    const comparison = await documentIntelligence.compareDocuments(prisma, {
      userId: ctx.userId,
      fileIds: ids,
      query,
      limit: safeLimit,
    });
    const analysisIds = (comparison.documents || []).map((item) => item.analysisId).filter(Boolean);
    ctx.onEvent?.({
      type: 'document_analysis',
      analysisIds,
      evidenceRefs: (comparison.documents || []).flatMap((doc) => (doc.evidence || []).slice(0, 3).map((item) => ({
        analysisId: doc.analysisId,
        chunkId: item.id,
        fileId: doc.fileId,
        sourceLabel: item.sourceLabel,
      }))),
      summary: `${comparison.comparisons?.length || 0} comparacion(es) documental(es)`,
    });
    ctx.onEvent?.({
      type: 'tool_output',
      tool: 'docintel_compare',
      ok: true,
      preview: `${comparison.documents?.length || 0} documentos, ${comparison.comparisons?.length || 0} cruces`,
    });
    return {
      ok: true,
      ...comparison,
      truncation: describeFileIdTruncation(fileIds, ctx),
      _preview: `${comparison.documents?.length || 0} documentos comparados`,
    };
  },
};

// ─── Cowork Agent Tools ──────────────────────────────────────────────────

let _deepDocAnalyzer;
function getDeepDocAnalyzer() {
  if (!_deepDocAnalyzer) _deepDocAnalyzer = require('../deep-document-analyzer');
  return _deepDocAnalyzer;
}

let _autoFileBridge;
function getAutoFileBridge() {
  if (!_autoFileBridge) _autoFileBridge = require('../auto-file-bridge');
  return _autoFileBridge;
}

let _activeMemory;
function getActiveMemory() {
  if (!_activeMemory) _activeMemory = require('../active-memory');
  return _activeMemory;
}

let _comparisonEngine;
function getComparisonEngine() {
  if (!_comparisonEngine) _comparisonEngine = require('../document-comparison-engine');
  return _comparisonEngine;
}

const deepAnalyze = {
  name: 'deep_analyze',
  description: 'Perform deep professional document analysis: domain detection (legal/financial/academic/medical/technical/business), entity extraction (PII, money, dates, IPs), risk assessment, quality scoring (A-F grade), structure mapping, auto-tagging. Use for professional-grade document analysis beyond basic text extraction.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Document text to analyze.' },
      fileName: { type: 'string', description: 'Optional filename for domain hints.' },
      mimeType: { type: 'string', description: 'Optional MIME type.' },
    },
    required: ['text'],
    additionalProperties: false,
  },
  async execute({ text, fileName = '', mimeType = '' } = {}, ctx = {}) {
    if (!text || typeof text !== 'string') {
      return { ok: false, error: 'deep_analyze requires non-empty "text"' };
    }
    ctx.onEvent?.({ type: 'tool_call', tool: 'deep_analyze', preview: previewText(text, 120) });
    try {
      const analyzer = getDeepDocAnalyzer();
      const result = await analyzer.analyzeDeep(text, {
        userId: ctx.userId,
        fileName,
        mimeType,
      });
      ctx.onEvent?.({ type: 'tool_output', tool: 'deep_analyze', ok: true, preview: `Domain: ${result.domain.primary}, Quality: ${result.quality.grade}, Risk: ${result.risks.severity}` });
      return {
        ok: true,
        domain: result.domain,
        quality: result.quality,
        risks: result.risks,
        piiSummary: result.piiSummary,
        structure: result.structure,
        keyPhrases: result.keyPhrases.slice(0, 10),
        autoTags: result.autoTags,
        summary: result.summary,
        _preview: `Domain: ${result.domain.primary} | Quality: ${result.quality.grade} (${result.quality.overall}/100) | Risk: ${result.risks.severity} | PII: ${result.piiSummary.total}`,
      };
    } catch (err) {
      ctx.onEvent?.({ type: 'tool_output', tool: 'deep_analyze', ok: false, preview: `Error: ${err.message}` });
      return { ok: false, error: err.message };
    }
  },
};

const autoFile = {
  name: 'auto_file',
  description: 'Automatically ingest pasted/dropped content as a virtual document with format detection, RAG indexing, and deep analysis. Use when the user pastes code, data, logs, JSON, CSV, or any structured content that should be treated as a document.',
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'Content to auto-file.' },
      fileName: { type: 'string', description: 'Optional filename override.' },
    },
    required: ['content'],
    additionalProperties: false,
  },
  async execute({ content, fileName } = {}, ctx = {}) {
    if (!content || typeof content !== 'string') {
      return { ok: false, error: 'auto_file requires non-empty "content"' };
    }
    const bridge = getAutoFileBridge();
    if (!bridge.shouldAutoFile(content)) {
      return { ok: false, error: 'Content too short or too long for auto-filing', _preview: 'Content not eligible for auto-filing' };
    }
    ctx.onEvent?.({ type: 'tool_call', tool: 'auto_file', preview: `${content.length} chars` });
    try {
      const result = await bridge.ingestPastedContent(ctx.userId, content, { fileName });
      ctx.onEvent?.({ type: 'tool_output', tool: 'auto_file', ok: result.autoFiled, preview: result.autoFiled ? `Filed as ${result.fileName}` : 'Auto-file failed' });
      return result;
    } catch (err) {
      ctx.onEvent?.({ type: 'tool_output', tool: 'auto_file', ok: false, preview: `Error: ${err.message}` });
      return { ok: false, error: err.message };
    }
  },
};

const memoryRecall = {
  name: 'memory_recall',
  description: 'Recall facts from the active memory system. Searches long-term and short-term memory by relevance. Use when you need user preferences, past context, or persistent facts about the user.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query for memory recall.' },
      limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Max results.' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async execute({ query, limit } = {}, ctx = {}) {
    if (!query || typeof query !== 'string') {
      return { ok: false, error: 'memory_recall requires a "query"' };
    }
    const safeLimit = clampInt(limit, { min: 1, max: 20, defaultValue: 5 });
    ctx.onEvent?.({ type: 'tool_call', tool: 'memory_recall', preview: previewText(query, 120) });
    try {
      const memory = getActiveMemory();
      const results = memory.recall(ctx.userId, query, { limit: safeLimit });
      ctx.onEvent?.({ type: 'tool_output', tool: 'memory_recall', ok: true, preview: `${results.length} memory match(es)` });
      return {
        ok: true,
        facts: results.map(r => ({
          fact: r.fact,
          tier: r.tier,
          category: r.category,
          strength: r.strength,
          score: r.score,
        })),
        _preview: `${results.length} memory fact(s) recalled`,
      };
    } catch (err) {
      ctx.onEvent?.({ type: 'tool_output', tool: 'memory_recall', ok: false, preview: `Error: ${err.message}` });
      return { ok: false, error: err.message };
    }
  },
};

const compareDocuments = {
  name: 'compare_documents',
  description: 'Compare 2+ documents for shared entities, contradictions, complementary insights, and cross-references. Returns alignment score, comparison matrix, and synthesis. Use when the user asks comparar, diferencias, similitudes between multiple documents.',
  parameters: {
    type: 'object',
    properties: {
      documents: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            text: { type: 'string' },
          },
        },
        description: 'Array of documents with id, name, text fields.',
      },
      query: { type: 'string', description: 'Optional focus area for comparison.' },
    },
    required: ['documents'],
    additionalProperties: false,
  },
  async execute({ documents = [], query = '' } = {}, ctx = {}) {
    if (!Array.isArray(documents) || documents.length < 2) {
      return { ok: false, error: 'compare_documents requires at least 2 documents' };
    }
    ctx.onEvent?.({ type: 'tool_call', tool: 'compare_documents', preview: `${documents.length} docs` });
    try {
      const engine = getComparisonEngine();

      const enrichedDocs = await Promise.all(documents.map(async doc => {
        if (doc.entities || doc.domain || doc.quality) return doc;
        try {
          const analyzer = getDeepDocAnalyzer();
          const analysis = await analyzer.analyzeDeep(doc.text || '', {
            userId: ctx.userId,
            fileName: doc.name,
          });
          return { ...doc, entities: analysis.entities, domain: analysis.domain.primary, quality: analysis.quality, structure: analysis.structure, risks: analysis.risks };
        } catch (_e) {
          return doc;
        }
      }));

      // The comparison engine returns a rich ComparisonReport with
      // pairs / entities / timeline / numericConflicts. Map it to the
      // agent-facing shape (alignment / contradictions / synthesis) so
      // downstream prompts keep their UX while the engine internals
      // stay untouched.
      const engineResult = engine.compareDocuments(enrichedDocs);
      if (!engineResult) {
        ctx.onEvent?.({ type: 'tool_output', tool: 'compare_documents', ok: false, preview: 'Insufficient comparable documents.' });
        return { ok: false, error: 'compareDocuments returned null — need ≥ 2 documents with extractable text' };
      }
      // alignment ≈ mean pairwise similarity (0..1)
      const pairs = Array.isArray(engineResult.pairs) ? engineResult.pairs : [];
      const alignmentScore = pairs.length
        ? pairs.reduce((s, p) => s + (Number(p.similarity) || 0), 0) / pairs.length
        : 0;
      // contradictions ≈ numericConflicts mapped to a uniform shape
      const contradictions = (engineResult.numericConflicts || []).map(c => ({
        label: c.label,
        description: `Numeric divergence in "${c.label}": ${(c.observations || []).map(o => `${o.file}=${o.value}`).join(' vs ')}`,
        observations: c.observations || [],
      }));
      const synthesis = engine.renderComparisonBlock(engineResult);
      const result = {
        ok: true,
        documentCount: engineResult.fileCount,
        alignmentScore,
        contradictions,
        synthesis,
        sharedEntities: engineResult.entities?.shared || { persons: [], organizations: [] },
        uniqueByFile: engineResult.entities?.uniqueByFile || [],
        timeline: engineResult.timeline || [],
        dominanceRatio: engineResult.dominanceRatio || 0,
        _engineReport: engineResult,
      };
      ctx.onEvent?.({ type: 'tool_output', tool: 'compare_documents', ok: true, preview: `${contradictions.length} contradictions, alignment ${Math.round(alignmentScore * 100)}%` });
      return {
        ...result,
        _preview: `${documents.length} docs compared | ${contradictions.length} contradictions | alignment: ${Math.round(alignmentScore * 100)}%`,
      };
    } catch (err) {
      ctx.onEvent?.({ type: 'tool_output', tool: 'compare_documents', ok: false, preview: `Error: ${err.message}` });
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
    // Canonical artifact ids are lowercase hex (artifactIdFor uses
    // digest('hex').slice). Lowercase before stripping so a caller who
    // pastes the id back as uppercase still finds the metadata sidecar.
    const id = String(artifactId || '').toLowerCase().replace(/[^a-f0-9]/g, '');
    if (!id) {
      ctx.onEvent?.({ type: 'tool_output', tool: 'verify_artifact', ok: false, preview: 'invalid artifact id' });
      return { ok: false, error: 'invalid artifact id' };
    }
    if (!fs.existsSync(ARTIFACT_DIR)) {
      ctx.onEvent?.({ type: 'tool_output', tool: 'verify_artifact', ok: false, preview: 'no artifacts dir' });
      return { ok: false, error: 'no artifacts directory yet' };
    }
    // Fast path: derive the on-disk filename from the metadata file
    // so we don't pay an O(N) directory scan when the artifact dir is
    // large. Fall back to readdirSync only if metadata is missing
    // (legacy artifacts written before metadata sidecars existed).
    let metadata = null;
    try {
      const metadataPath = metadataPathFor(id);
      if (fs.existsSync(metadataPath)) metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    } catch { /* metadata is auxiliary */ }
    if (ctx.userId) {
      if (!metadata?.ownerUserId) {
        ctx.onEvent?.({ type: 'tool_output', tool: 'verify_artifact', ok: false, preview: 'artifact ownership metadata missing' });
        return { ok: false, error: 'artifact ownership metadata missing' };
      }
      if (String(metadata.ownerUserId) !== String(ctx.userId)) {
        ctx.onEvent?.({ type: 'tool_output', tool: 'verify_artifact', ok: false, preview: 'artifact not found' });
        return { ok: false, error: 'artifact not found' };
      }
    }

    // Resolve the on-disk path. Cycle artifacts are grouped under
    // ARTIFACT_DIR/<folderCode>/ and record `storedRelPath` in their flat
    // metadata; legacy artifacts live at the top level under `<id>-<name>`.
    let full = null;
    let entry = null;
    if (metadata?.storedRelPath) {
      const root = path.resolve(ARTIFACT_DIR);
      const candidate = path.resolve(ARTIFACT_DIR, metadata.storedRelPath);
      // Traversal guard: the resolved path must stay inside ARTIFACT_DIR.
      if ((candidate === root || candidate.startsWith(root + path.sep)) && fs.existsSync(candidate)) {
        full = candidate;
        entry = path.basename(candidate);
      }
    }
    if (!full && metadata?.filename) {
      const candidate = `${id}-${metadata.filename}`;
      if (fs.existsSync(path.join(ARTIFACT_DIR, candidate))) {
        entry = candidate;
        full = path.join(ARTIFACT_DIR, candidate);
      }
    }
    if (!full) {
      entry = fs.readdirSync(ARTIFACT_DIR).find(f => f.startsWith(`${id}-`)) || null;
      if (entry) full = path.join(ARTIFACT_DIR, entry);
    }
    if (!full || !entry) {
      ctx.onEvent?.({ type: 'tool_output', tool: 'verify_artifact', ok: false, preview: 'artifact not found' });
      return { ok: false, error: `artifact ${id} not found` };
    }
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
    const lastLine = (r.stdout || '').trim().split('\n').filter(Boolean).pop();
    if (!lastLine) {
      // No stdout at all — likely Python interpreter unavailable, or
      // the sandbox aborted before the script ran. Surface the
      // sandbox status so the caller can react instead of pretending
      // the file passed verification.
      summary = {
        ok: false,
        error: r.timedOut ? 'verifier timed out' : (r.aborted ? 'verifier aborted' : 'verifier produced no output'),
        ext, sizeBytes,
        stdout: previewText(r.stdout || '', 600),
        stderr: previewText(r.stderr || '', 600),
      };
    } else {
      try {
        summary = JSON.parse(lastLine);
      } catch {
        summary = { ok: false, error: 'verifier output was not valid JSON', stdout: previewText(r.stdout || '', 600), stderr: previewText(r.stderr || '', 600) };
      }
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
  if (typeof s.charCount === 'number' && typeof s.lineCount !== 'number') parts.push(`${s.charCount} chars`);
  if (typeof s.arrayLength === 'number') parts.push(`array[${s.arrayLength}]`);
  if (Array.isArray(s.topLevelKeys)) parts.push(`${s.topLevelKeys.length} claves`);
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
    const allowedLangs = new Set(['python', 'javascript', 'node']);
    if (!allowedLangs.has(language)) {
      ctx.onEvent?.({ type: 'tool_output', tool: 'run_tests', ok: false, preview: 'unsupported language' });
      return { ok: false, error: `run_tests "language" must be one of ${Array.from(allowedLangs).join(', ')}` };
    }
    if (typeof source !== 'string' || !source.trim()) {
      return { ok: false, error: 'run_tests requires a non-empty "source"' };
    }
    if (typeof testSource !== 'string' || !testSource.trim()) {
      return { ok: false, error: 'run_tests requires a non-empty "testSource"' };
    }
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
      timeoutMs: clampTimeoutMs(timeoutMs, { min: 500, max: 60000, defaultMs: 10000 }),
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
    const allFailures = r.failures || [];
    return {
      ok: r.ok,
      passed: r.passed,
      failed: r.failed,
      timedOut: r.timedOut,
      durationMs: r.durationMs,
      failures: allFailures.slice(0, 10),
      failuresTruncated: allFailures.length > 10,
      totalFailures: allFailures.length,
      stdout: previewText(r.stdout || '', 1200),
      stderr: previewText(r.stderr || '', 800),
    };
  },
};

// ─── Professional document cycle: per-stage progress ───────────────────
// Lets the agent announce which of the 5 cycle stages it is entering so the
// UI can render visible progress (cycle_stage events). Harmless for non-cycle
// tasks: the agent only calls it when the cycle contract instructs it to.
const CYCLE_STAGE_LABELS = {
  guide_review: 'Revisión de la guía',
  analysis: 'Análisis de tipo y campo',
  research: 'Investigación de fuentes',
  drafting: 'Redacción del documento',
  finalize: 'Exportación y organización',
};

const reportStage = {
  name: 'report_stage',
  description: 'Marca el avance del ciclo profesional de documentos. Llama esta herramienta al INICIO de cada etapa (guide_review, analysis, research, drafting, finalize) y, opcionalmente, al terminarla con status="done". Sirve para que el usuario vea el progreso por etapas.',
  parameters: {
    type: 'object',
    properties: {
      stage: {
        type: 'string',
        enum: ['guide_review', 'analysis', 'research', 'drafting', 'finalize'],
        description: 'Identificador de la etapa actual del ciclo.',
      },
      note: { type: 'string', description: 'Breve descripción en español de lo que harás (o hiciste) en esta etapa.' },
      status: { type: 'string', enum: ['start', 'done'], description: 'start al comenzar la etapa (por defecto), done al completarla.' },
    },
    required: ['stage'],
    additionalProperties: false,
  },
  async execute({ stage, note, status }, ctx = {}) {
    const safeStage = CYCLE_STAGE_LABELS[stage] ? stage : null;
    if (!safeStage) {
      ctx.onEvent?.({ type: 'tool_output', tool: 'report_stage', ok: false, preview: `etapa desconocida: ${stage}` });
      return { ok: false, error: `unknown stage: ${stage}` };
    }
    const safeStatus = status === 'done' ? 'done' : 'start';
    const label = CYCLE_STAGE_LABELS[safeStage];
    const cleanNote = typeof note === 'string' ? note.slice(0, 280) : '';
    ctx.onEvent?.({ type: 'tool_call', tool: 'report_stage', preview: label });
    ctx.onEvent?.({ type: 'cycle_stage', stage: safeStage, status: safeStatus, label, note: cleanNote });
    ctx.onEvent?.({
      type: 'tool_output',
      tool: 'report_stage',
      ok: true,
      preview: `${safeStatus === 'done' ? '✓ ' : '▶ '}${label}${cleanNote ? ` — ${cleanNote}` : ''}`,
    });
    return { ok: true, stage: safeStage, status: safeStatus, label };
  },
};

// ─── Assembly ──────────────────────────────────────────────────────────

/**
 * @returns {Array<object>} the tools array to pass into react-agent's
 * `tools` parameter.
 */
function buildTaskTools() {
  return [
    pythonExec,
    bashExec,
    webSearch,
    createDocument,
    ragRetrieve,
    selfRagAnswer,
    docintelAnalyze,
    docintelRetrieve,
    docintelExtractTables,
    docintelCompare,
    deepAnalyze,
    autoFile,
    memoryRecall,
    compareDocuments,
    verifyArtifact,
    runTests,
    reportStage,
    // Visual & media generation tools
    ...visualMediaTools,
  ];
}

// Lazy-load visual-media-tools to break circular dependency:
// visual-media-tools.js requires this module (saveArtifact, INTERNAL),
// so we cannot require() it at module scope.
let _visualMediaTools = null;
function getVisualMediaTools() {
  if (!_visualMediaTools) {
    _visualMediaTools = require('./visual-media-tools').VISUAL_MEDIA_TOOLS;
  }
  return _visualMediaTools;
}

// Proxy that resolves the visual tools array lazily at runtime
const visualMediaTools = new Proxy([], {
  get(_, prop) {
    return getVisualMediaTools()[prop];
  },
  ownKeys() {
    return Reflect.ownKeys(getVisualMediaTools());
  },
  getOwnPropertyDescriptor() {
    return { configurable: true, enumerable: true };
  },
});

// Resolve visual media module lazily in INTERNAL to break cycles
let _vmtInternal = null;
function getVisualMediaInternal() {
  if (!_vmtInternal) _vmtInternal = require('./visual-media-tools');
  return _vmtInternal;
}

// ─────────────────────────────────────────────────────────────────────────
// Library categorisation — maps a stored artifact's metadata to one of the
// file-library media tabs (image/video/audio/music/webapp/mobileapp). Used by
// GET /api/library/media-library to surface generated audio, music and apps
// (which live in this artifact store, NOT inline on message.files like the
// chat-generated images/videos).
// ─────────────────────────────────────────────────────────────────────────
const LIBRARY_AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac']);
const LIBRARY_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico']);
const LIBRARY_VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'm4v']);
const LIBRARY_WEBAPP_EXTS = new Set(['html', 'htm']);
const LIBRARY_MOBILE_EXTS = new Set(['apk', 'ipa', 'aab']);
const LIBRARY_CATEGORIES = ['image', 'video', 'audio', 'music', 'webapp', 'mobileapp'];

// Best-effort: classify an artifact into a library media category, or null
// when it is not a media artifact (e.g. docx/pdf/csv/json/code).
function categorizeArtifact(meta) {
  if (!meta) return null;
  const explicit = String(meta.category || '').toLowerCase();
  if (LIBRARY_CATEGORIES.includes(explicit)) return explicit;
  const ext = String(meta.format || '').toLowerCase();
  const mime = String(meta.mime || '').toLowerCase();
  const name = String(meta.filename || '').toLowerCase();
  if (LIBRARY_MOBILE_EXTS.has(ext)) return 'mobileapp';
  if (mime.startsWith('audio/') || LIBRARY_AUDIO_EXTS.has(ext)) {
    // The music tool names files `cancion_*`; the speech tool uses `voz_*`.
    // Fall back to keyword sniffing for legacy artifacts saved before the
    // explicit `category` field existed.
    if (/^cancion[_-]/.test(name) || /(music|song|cancion|melod|jingle|soundtrack|instrumental|track)/.test(name)) {
      return 'music';
    }
    return 'audio';
  }
  if (mime.startsWith('video/') || LIBRARY_VIDEO_EXTS.has(ext)) return 'video';
  if (mime.startsWith('image/') || LIBRARY_IMAGE_EXTS.has(ext)) return 'image';
  if (mime === 'text/html' || LIBRARY_WEBAPP_EXTS.has(ext)) return 'webapp';
  return null;
}

// List a user's media artifacts from the on-disk artifact store, normalised
// into the same item shape the library frontend already renders. Owner-scoped:
// only metadata whose ownerUserId matches is returned. `categories` optionally
// narrows to specific tabs; `max` bounds the directory scan.
function listArtifactsByOwner(ownerUserId, { categories, max = 5000 } = {}) {
  if (ownerUserId == null) return [];
  const wanted = Array.isArray(categories) && categories.length ? new Set(categories) : null;
  let files;
  try {
    if (!fs.existsSync(ARTIFACT_DIR)) return [];
    // Metadata files are exactly `<16-hex-id>.json`; binary artifacts that
    // happen to be JSON are stored as `<id>-<name>.json` (with a dash), so
    // this pattern excludes them.
    files = fs.readdirSync(ARTIFACT_DIR).filter((f) => /^[a-f0-9]{16}\.json$/.test(f));
  } catch {
    return [];
  }
  const items = [];
  for (const f of files) {
    if (items.length >= max) break;
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(ARTIFACT_DIR, f), 'utf8'));
    } catch {
      continue;
    }
    if (!meta || String(meta.ownerUserId) !== String(ownerUserId)) continue;
    const category = categorizeArtifact(meta);
    if (!category) continue;
    if (wanted && !wanted.has(category)) continue;
    const downloadUrl = `/api/agent/artifact/${meta.id}?name=${encodeURIComponent(meta.filename || 'artifact')}`;
    items.push({
      messageId: meta.id,
      id: meta.id,
      chatId: meta.chatId || null,
      timestamp: meta.createdAt || null,
      type: category,
      url: downloadUrl,
      download_url: downloadUrl,
      filename: meta.filename || null,
      mime: meta.mime || null,
      sizeBytes: meta.sizeBytes || 0,
      prompt: meta.filename || category,
      source: 'artifact',
    });
  }
  items.sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
  return items;
}

module.exports = {
  buildTaskTools,
  saveArtifact,
  listArtifactsByOwner,
  categorizeArtifact,
  ARTIFACT_DIR,
  EXTENSION_TO_MIME,
  get VISUAL_MEDIA_TOOLS() { return getVisualMediaTools(); },
  INTERNAL: {
    pythonExec,
    bashExec,
    webSearch,
    createDocument,
    ragRetrieve,
    selfRagAnswer,
    docintelAnalyze,
    docintelRetrieve,
    docintelExtractTables,
    docintelCompare,
    deepAnalyze,
    autoFile,
    memoryRecall,
    compareDocuments,
    verifyArtifact,
    runTests,
    reportStage,
    previewText,
    artifactIdFor,
    metadataPathFor,
    sanitizeArtifactFilename,
    assertArtifactSizeWithinLimit,
    ACTIVE_TEXT_ARTIFACT_EXTENSIONS,
    ACTIVE_TEXT_ARTIFACT_MAX_BYTES,
    clampTimeoutMs,
    clampInt,
    describeFileIdTruncation,
    TOOL_FILE_ID_CAP,
    summarisePreview,
    validateAgentArtifactBuffer,
    assertArtifactValidation,
    bufferHasMagic,
    BINARY_MAGIC_SIGNATURES,
  },
};
