/**
 * canonical-document-ast — phase 8 of the DocumentRenderingEngine.
 *
 * Typed contract every doc-generator emit MUST conform to before the
 * format-specific compilers (DOCX/PDF/PPTX/XLSX/Markdown) walk it.
 * The user's design called this out explicitly: "todo contenido
 * generado por el modelo debe pasar primero por un
 * CanonicalDocumentAST donde se separen bloques paragraph, heading,
 * table, image, code, inline_math, block_math, citation, chart,
 * page_break y artifact_metadata".
 *
 * This module ships the contract — schema, validator, builders. The
 * format-specific compilers (and the LLM-output-to-AST translator)
 * are intentionally separate work; they slot into this contract
 * once we're ready to migrate the existing python-emit path off
 * its free-form scripts. Until then the contract:
 *
 *   1. Locks the failure modes the validation fabric needs to
 *      observe — every block has a single discriminating `type`,
 *      every required field has a defined name and shape.
 *   2. Lets validators (math, layout, citation) walk an AST
 *      uniformly instead of re-parsing every format separately.
 *   3. Documents the canonical output shape for any future caller
 *      that wants to emit documents without going through the
 *      Python sandbox.
 *
 * Public API:
 *   BLOCK_TYPES                — frozen list of block discriminators
 *   SCHEMA_VERSION             — bump on breaking change
 *   validateCanonicalAst(ast)  -> { ok, errors: [{path, reason}] }
 *   emptyAst(opts)             -> a fresh, empty document
 *   paragraph / heading / table / image / code / inlineMath /
 *     blockMath / citation / chart / pageBreak / artifactMetadata
 *                               -> typed block builders
 */

const SCHEMA_VERSION = 'sira.canonical_document.v1';

const BLOCK_TYPES = Object.freeze([
  'paragraph',
  'heading',
  'table',
  'image',
  'code',
  'inline_math',
  'block_math',
  'citation',
  'chart',
  'page_break',
  'artifact_metadata',
]);

const FORMATS = Object.freeze(['docx', 'xlsx', 'pptx', 'pdf', 'svg', 'csv', 'md', 'html']);

// ── Per-block validators ────────────────────────────────────────────────
//
// Each returns `null` when the block is well-formed, or a string
// reason when it's not. Path-prefixing happens in the walker.

function _isStr(v)        { return typeof v === 'string' && v.length > 0; }
function _isNum(v)        { return typeof v === 'number' && Number.isFinite(v); }
function _isInt(v, lo, hi) { return Number.isInteger(v) && (lo === undefined || v >= lo) && (hi === undefined || v <= hi); }
function _isObj(v)        { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function _v_paragraph(b) {
  if (!_isStr(b.text)) return 'paragraph.text must be a non-empty string';
  if (b.indent != null && !_isNum(b.indent)) return 'paragraph.indent must be number when present';
  if (b.italic != null && typeof b.italic !== 'boolean') return 'paragraph.italic must be boolean';
  if (b.bold != null && typeof b.bold !== 'boolean') return 'paragraph.bold must be boolean';
  return null;
}

function _v_heading(b) {
  if (!_isInt(b.level, 1, 6)) return 'heading.level must be an integer 1..6';
  if (!_isStr(b.text)) return 'heading.text must be a non-empty string';
  return null;
}

function _v_table(b) {
  if (!Array.isArray(b.headers) || b.headers.length === 0) return 'table.headers must be a non-empty array';
  if (b.headers.some((h) => typeof h !== 'string')) return 'table.headers entries must all be strings';
  if (!Array.isArray(b.rows)) return 'table.rows must be an array (may be empty)';
  for (let i = 0; i < b.rows.length; i += 1) {
    const row = b.rows[i];
    if (!Array.isArray(row)) return `table.rows[${i}] must be an array`;
    if (row.length !== b.headers.length) return `table.rows[${i}] length ${row.length} ≠ headers length ${b.headers.length}`;
  }
  return null;
}

function _v_image(b) {
  if (!_isStr(b.src)) return 'image.src must be a non-empty string';
  if (b.alt != null && typeof b.alt !== 'string') return 'image.alt must be a string when present';
  if (b.width != null && !_isNum(b.width)) return 'image.width must be number when present';
  return null;
}

function _v_code(b) {
  if (!_isStr(b.language)) return 'code.language must be a non-empty string';
  if (typeof b.source !== 'string') return 'code.source must be a string (possibly empty)';
  return null;
}

function _v_inline_math(b) {
  if (!_isStr(b.latex)) return 'inline_math.latex must be a non-empty string';
  return null;
}

function _v_block_math(b) {
  if (!_isStr(b.latex)) return 'block_math.latex must be a non-empty string';
  return null;
}

function _v_citation(b) {
  if (!_isStr(b.label)) return 'citation.label must be a non-empty string';
  if (b.source != null && !_isStr(b.source)) return 'citation.source must be a string when present';
  if (b.page != null && !_isInt(b.page, 1)) return 'citation.page must be a positive integer when present';
  return null;
}

function _v_chart(b) {
  if (!_isStr(b.kind)) return 'chart.kind must be a non-empty string';
  if (b.data == null) return 'chart.data is required (object or array)';
  return null;
}

function _v_page_break(_b) {
  return null;
}

function _v_artifact_metadata(b) {
  if (b.title != null && !_isStr(b.title)) return 'artifact_metadata.title must be a string when present';
  if (b.author != null && !_isStr(b.author)) return 'artifact_metadata.author must be a string when present';
  if (b.language != null && !_isStr(b.language)) return 'artifact_metadata.language must be a string when present';
  return null;
}

const BLOCK_VALIDATORS = {
  paragraph:         _v_paragraph,
  heading:           _v_heading,
  table:             _v_table,
  image:             _v_image,
  code:              _v_code,
  inline_math:       _v_inline_math,
  block_math:        _v_block_math,
  citation:          _v_citation,
  chart:             _v_chart,
  page_break:        _v_page_break,
  artifact_metadata: _v_artifact_metadata,
};

// ── Top-level validator ────────────────────────────────────────────────

function validateCanonicalAst(ast) {
  const errors = [];
  if (!_isObj(ast)) return { ok: false, errors: [{ path: '$', reason: 'ast must be an object' }] };
  if (ast.kind !== SCHEMA_VERSION) {
    errors.push({ path: '$.kind', reason: `expected "${SCHEMA_VERSION}", got "${ast.kind}"` });
  }
  if (!_isStr(ast.format) || !FORMATS.includes(ast.format)) {
    errors.push({ path: '$.format', reason: `must be one of ${FORMATS.join('|')}` });
  }
  if (ast.title != null && !_isStr(ast.title)) {
    errors.push({ path: '$.title', reason: 'title must be a non-empty string when present' });
  }
  if (ast.language != null && !_isStr(ast.language)) {
    errors.push({ path: '$.language', reason: 'language must be a string when present' });
  }
  if (!Array.isArray(ast.blocks)) {
    errors.push({ path: '$.blocks', reason: 'blocks must be an array' });
    return { ok: errors.length === 0, errors };
  }
  for (let i = 0; i < ast.blocks.length; i += 1) {
    const block = ast.blocks[i];
    const path = `$.blocks[${i}]`;
    if (!_isObj(block)) {
      errors.push({ path, reason: 'block must be an object' });
      continue;
    }
    if (!_isStr(block.type) || !BLOCK_TYPES.includes(block.type)) {
      errors.push({ path: `${path}.type`, reason: `unknown block type "${block.type}" (expected one of ${BLOCK_TYPES.join('|')})` });
      continue;
    }
    const validator = BLOCK_VALIDATORS[block.type];
    const reason = validator(block);
    if (reason) errors.push({ path, reason });
  }
  return { ok: errors.length === 0, errors };
}

// ── Builders — typed factories for each block kind ─────────────────────

function emptyAst({ format = 'docx', title = null, language = 'es' } = {}) {
  return {
    kind: SCHEMA_VERSION,
    format,
    title,
    language,
    blocks: [],
  };
}

function paragraph(text, opts = {}) {
  return Object.assign({ type: 'paragraph', text }, opts);
}

function heading(level, text) {
  return { type: 'heading', level, text };
}

function table({ headers, rows, caption = null, note = null } = {}) {
  return { type: 'table', headers, rows, caption, note };
}

function image({ src, alt = '', width = null }) {
  return { type: 'image', src, alt, width };
}

function code(language, source) {
  return { type: 'code', language, source };
}

function inlineMath(latex) {
  return { type: 'inline_math', latex };
}

function blockMath(latex) {
  return { type: 'block_math', latex };
}

function citation({ label, source = null, page = null }) {
  return { type: 'citation', label, source, page };
}

function chart({ kind, data, title = null }) {
  return { type: 'chart', kind, data, title };
}

function pageBreak() {
  return { type: 'page_break' };
}

function artifactMetadata({ title = null, author = null, language = null, createdAt = null } = {}) {
  return { type: 'artifact_metadata', title, author, language, createdAt };
}

module.exports = {
  SCHEMA_VERSION,
  BLOCK_TYPES,
  FORMATS,
  validateCanonicalAst,
  emptyAst,
  paragraph,
  heading,
  table,
  image,
  code,
  inlineMath,
  blockMath,
  citation,
  chart,
  pageBreak,
  artifactMetadata,
};
