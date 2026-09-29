'use strict';

// Read statistical files inside the existing isolated document sandbox. A
// preview is a bounded data page, never a guessed PDF or an LLM response.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const FORMATS = new Set(['sav', 'zsav', 'por']);
const MAX_SOURCE_BYTES = 40 * 1024 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_COLUMNS = 100;
const MAX_CELLS = 10000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 12;
const cache = new Map();
const inFlight = new Map();
let readingSources = 0;

class DataPreviewError extends Error {
  constructor(code, status = 409) {
    super(code);
    this.name = 'DataPreviewError';
    this.code = code;
    this.status = status;
  }
}

function dataPreviewFormat(filename) {
  const ext = path.extname(String(filename || '')).slice(1).toLowerCase();
  return FORMATS.has(ext) ? ext : null;
}

function boundedInteger(value, fallback, maximum) {
  const raw = Number(value);
  return Number.isSafeInteger(raw) && raw >= 0 ? Math.min(raw, maximum) : fallback;
}

function dataPreviewOptions({ limit, offset } = {}) {
  return {
    limit: Math.max(1, boundedInteger(limit, 200, 500)),
    offset: boundedInteger(offset, 0, 10000000),
  };
}

const READER_SOURCE = String.raw`
import json, math, numbers, sys
try:
    import pyreadstat
except ImportError:
    print(json.dumps({"ok": False, "code": "PREVIEW_READER_UNAVAILABLE"}))
    sys.exit(0)

source, destination, fmt, limit, offset = sys.argv[1:]
limit, offset = int(limit), int(offset)
reader = pyreadstat.read_por if fmt == "por" else pyreadstat.read_sav
options = {} if fmt == "por" else {"user_missing": True}
truncated_values = False
def safe_text(value, size=256):
    global truncated_values
    text = str(value)
    if len(text) > size:
        truncated_values = True
        return text[:size]
    return text
def scalar(value):
    if value is None: return None
    if isinstance(value, numbers.Integral): return int(value)
    if isinstance(value, numbers.Real):
        number = float(value)
        return number if math.isfinite(number) else None
    if hasattr(value, "isoformat"): return value.isoformat()
    return safe_text(value)
def label_key(value):
    if isinstance(value, numbers.Real) and math.isfinite(float(value)) and float(value).is_integer():
        return str(int(value))
    return safe_text(value)
try:
    _, metadata = reader(source, metadataonly=True, **options)
    names = list(metadata.column_names or [])
    if not names: raise ValueError("empty variables")
    selected = names[:100]
    effective_limit = min(limit, max(1, 10000 // len(selected)))
    values, read_metadata = reader(source, usecols=selected, row_limit=effective_limit + 1,
        row_offset=offset, output_format="dict", **options)
    page_count = len(values[selected[0]])
    row_count = metadata.number_rows
    known_count = isinstance(row_count, numbers.Integral) and int(row_count) >= 0
    if not known_count and offset == 0 and page_count <= effective_limit:
        row_count = offset + page_count
        known_count = True
    labels = metadata.column_names_to_labels or {}
    types = metadata.readstat_variable_types or {}
    value_labels = metadata.variable_value_labels or {}
    missing = metadata.missing_ranges or {}
    measures = metadata.variable_measure or {}
    formats = metadata.original_variable_types or {}
    columns = []
    for name in selected:
        name_labels = value_labels.get(name, {})
        if len(name_labels) > 100: truncated_values = True
        columns.append({"name": safe_text(name), "label": safe_text(labels.get(name) or ""),
            "type": "string" if types.get(name) == "string" else "numeric",
            "valueLabels": {label_key(code): safe_text(label) for code, label in list(name_labels.items())[:100]},
            "missingValues": [{"lo": scalar(item.get("lo")), "hi": scalar(item.get("hi"))} for item in missing.get(name, [])[:10]],
            "measure": safe_text(measures.get(name) or ""), "format": safe_text(formats.get(name) or "")})
    rows = [[scalar(values[name][i]) for name in selected] for i in range(min(effective_limit, page_count))]
    has_more = page_count > effective_limit or (known_count and offset + len(rows) < int(row_count))
    result = {"format": fmt, "rowCount": int(row_count) if known_count else None,
        "rowCountKnown": bool(known_count), "columnCount": len(names), "columns": columns,
        "rows": rows, "offset": offset, "limit": effective_limit, "hasMore": bool(has_more),
        "truncated": {"rows": bool(offset > 0 or has_more), "columns": len(names) > len(selected), "values": bool(truncated_values)}}
    encoded = json.dumps(result, ensure_ascii=False, allow_nan=False).encode("utf-8")
    if len(encoded) > 2097152: raise OverflowError("preview limit")
    with open(destination, "wb") as output: output.write(encoded)
    print(json.dumps({"ok": True}))
except Exception:
    print(json.dumps({"ok": False, "code": "PREVIEW_DATA_UNREADABLE"}))
`;

function quoteShell(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function assertPreviewPayload(data, { format, limit, offset }) {
  if (!data || data.format !== format || !Array.isArray(data.columns) || !data.columns.length
    || data.columns.length > MAX_COLUMNS || !Array.isArray(data.rows)
    || data.rows.length > limit || data.rows.length * data.columns.length > MAX_CELLS
    || data.offset !== offset || !Number.isSafeInteger(data.limit) || data.limit < 1 || data.limit > limit
    || !Number.isSafeInteger(data.columnCount) || data.columnCount < data.columns.length
    || (data.rowCount !== null && (!Number.isSafeInteger(data.rowCount) || data.rowCount < 0))
    || data.rowCountKnown !== (data.rowCount !== null) || typeof data.hasMore !== 'boolean'
    || !data.truncated || ['rows', 'columns', 'values'].some((key) => typeof data.truncated[key] !== 'boolean')) {
    throw new DataPreviewError('PREVIEW_DATA_UNREADABLE');
  }
  const validScalar = (value) => value === null || typeof value === 'string'
    || (typeof value === 'number' && Number.isFinite(value));
  if (data.rows.some((row) => !Array.isArray(row) || row.length !== data.columns.length || row.some((value) => !validScalar(value)))
    || data.columns.some((column) => !column || typeof column.name !== 'string' || !column.name
      || typeof column.label !== 'string' || !['numeric', 'string'].includes(column.type)
      || !column.valueLabels || typeof column.valueLabels !== 'object' || Array.isArray(column.valueLabels)
      || !Array.isArray(column.missingValues))) {
    throw new DataPreviewError('PREVIEW_DATA_UNREADABLE');
  }
  return data;
}

async function readPreviewInSandbox(buffer, options, createSandbox) {
  let sandbox;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    sandbox = await createSandbox({ signal: controller.signal });
    const sourcePath = await sandbox.putFile(`uploads/preview.${options.format}`, buffer);
    const scriptPath = await sandbox.writeFile('tmp/read-statistical-preview.py', READER_SOURCE);
    // writeFile returns void for some drivers; use the canonical workspace path.
    const resultPath = '/workspace/tmp/statistical-preview.json';
    const command = `python3 ${quoteShell(scriptPath || '/workspace/tmp/read-statistical-preview.py')} ${quoteShell(sourcePath)} ${quoteShell(resultPath)} ${quoteShell(options.format)} ${options.limit} ${options.offset}`;
    const run = await sandbox.exec(command, { timeoutMs: 20000 });
    if (run?.timedOut) throw new DataPreviewError('PREVIEW_DATA_TIMEOUT', 504);
    if (run?.exitCode !== 0) throw new DataPreviewError('PREVIEW_READER_UNAVAILABLE', 503);
    let verdict;
    try { verdict = JSON.parse(String(run.stdout || '').trim().split('\n').at(-1)); }
    catch { throw new DataPreviewError('PREVIEW_DATA_UNREADABLE'); }
    if (verdict?.ok !== true) {
      throw new DataPreviewError(verdict?.code === 'PREVIEW_READER_UNAVAILABLE'
        ? 'PREVIEW_READER_UNAVAILABLE' : 'PREVIEW_DATA_UNREADABLE', verdict?.code === 'PREVIEW_READER_UNAVAILABLE' ? 503 : 409);
    }
    const bytes = await sandbox.readFile('tmp/statistical-preview.json');
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_JSON_BYTES) throw new DataPreviewError('PREVIEW_DATA_LIMIT_EXCEEDED', 413);
    let data;
    try { data = JSON.parse(bytes.toString('utf8')); }
    catch { throw new DataPreviewError('PREVIEW_DATA_UNREADABLE'); }
    return assertPreviewPayload(data, options);
  } catch (error) {
    if (error instanceof DataPreviewError) throw error;
    if (controller.signal.aborted) throw new DataPreviewError('PREVIEW_DATA_TIMEOUT', 504);
    throw new DataPreviewError('PREVIEW_READER_UNAVAILABLE', 503);
  } finally {
    clearTimeout(timer);
    try { await sandbox?.destroy(); } catch { /* ephemeral sandbox cleanup */ }
  }
}

async function getStructuredDataPreview({ sourcePath, filename, cacheScope, limit, offset,
  createSandbox = require('../doc-agent/sandbox').createSandbox } = {}) {
  const format = dataPreviewFormat(filename);
  if (!format) throw new DataPreviewError('PREVIEW_FORMAT_UNSUPPORTED', 415);
  const options = { format, ...dataPreviewOptions({ limit, offset }) };
  const stat = await fs.stat(sourcePath);
  if (!stat.isFile() || stat.size === 0) throw new DataPreviewError('PREVIEW_DATA_UNREADABLE');
  if (stat.size > MAX_SOURCE_BYTES) throw new DataPreviewError('PREVIEW_SOURCE_TOO_LARGE', 413);
  // Reserve before reading a potentially 40 MiB source. The parser slots
  // alone would still let a burst allocate unbounded source buffers first.
  if (readingSources + inFlight.size >= 2) throw new DataPreviewError('PREVIEW_DATA_BUSY', 503);
  readingSources++;
  let buffer;
  try { buffer = await fs.readFile(sourcePath); }
  finally { readingSources--; }
  if (buffer.length > MAX_SOURCE_BYTES) throw new DataPreviewError('PREVIEW_SOURCE_TOO_LARGE', 413);
  const digest = crypto.createHash('sha256').update(buffer).digest('hex');
  const key = `${cacheScope || ''}:${format}:${digest}:${options.limit}:${options.offset}`;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return { ...cached.data, filename };
  cache.delete(key);
  if (inFlight.has(key)) return { ...await inFlight.get(key), filename };
  if (inFlight.size >= 2) throw new DataPreviewError('PREVIEW_DATA_BUSY', 503);
  const job = readPreviewInSandbox(buffer, options, createSandbox).then((data) => {
    while (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(key, { data, expires: Date.now() + CACHE_TTL_MS });
    return data;
  }).finally(() => inFlight.delete(key));
  inFlight.set(key, job);
  return { ...await job, filename };
}

module.exports = { getStructuredDataPreview, dataPreviewFormat, dataPreviewOptions,
  DataPreviewError, MAX_SOURCE_BYTES, READER_SOURCE, assertPreviewPayload };
