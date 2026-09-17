'use strict';

/**
 * Surgical-editing rules — the design principle behind every document edit.
 *
 * The model NEVER regenerates the document. It opens the ORIGINAL file inside
 * an isolated sandbox, locates the exact nodes to touch (XML in Office
 * formats, objects in PDF), modifies them with scripts, validates that
 * nothing else changed, and returns the same file. That is what keeps the
 * formatting alive.
 *
 * Two sandbox routes share the same orchestration layer (doc-agent/index.js),
 * so callers can launch on the fast route and swap the engine later without
 * touching the frontend:
 *   Route A — Anthropic sandbox (see ./anthropic-route.js)
 *   Route B — own Docker sandbox (see ./sandbox.js + infra/sandbox/Dockerfile)
 *
 * This module is pure (no I/O, no deps) so it is cheap to unit-test and safe
 * to inject into system prompts.
 */

// Parts that MUST NOT be touched unless the user explicitly asked for
// "modo reformateo" (full reformat). Listed as ZIP entry suffixes / names.
// NOTE: docProps (core/app) are deliberately NOT here — Word/LibreOffice and
// the python libs rewrite timestamps on every save, so CRC-flagging them
// would false-positive on every legitimate edit. Margins/sectPr live inside
// word/document.xml itself and are covered by the prompt contract, not by CRC.
const FORBIDDEN_PARTS = Object.freeze([
  '[Content_Types].xml',
  'word/styles.xml',
  'word/numbering.xml',
  'word/theme/theme1.xml',
  'xl/styles.xml',
  'xl/theme/theme1.xml',
  'ppt/theme/theme1.xml',
  'ppt/slideMasters/',
  'ppt/slideLayouts/',
  'ppt/presentation.xml',
]);

// Fixed skill order for prompt-cache stability: keep the list identical per
// file type and never vary it per user. Progressive disclosure — the base
// prompt lists names only; the full SKILL.md enters context when the worker
// detects the file extension.
const SKILL_ORDER = Object.freeze(['docx', 'xlsx', 'pptx', 'pdf', 'csv', 'txt']);

const REFORMATEO_RE = /(modo\s+reformateo|reformateo|reformat\s+mode|rediseñ\w*\s+(completo|total)|cambia?\s+(el\s+)?(tema|theme|plantilla|diseño))/i;

function isReformateoRequest(instruction = '') {
  return REFORMATEO_RE.test(String(instruction || ''));
}

const SURGICAL_RULES = `SURGICAL EDITING — GOLDEN RULE
The model NEVER regenerates the document. Open the ORIGINAL file inside the
sandbox, locate the EXACT nodes to touch (XML in Office formats, objects in
PDF), modify them with scripts, validate that nothing else changed, and return
the SAME file. That is what keeps the formatting alive.

DOCX/XLSX/PPTX (and ODT/ODS/ODP) are ZIP + XML. Unpack, edit the exact text
node preserving its formatting properties (w:rPr, a:rPr, the style attribute
"s" on cells), and repack with the SAME parts in the SAME order.
FORBIDDEN in the system prompt unless the user explicitly asked for
"modo reformateo": touching styles.xml, numbering.xml, theme, layouts,
masters, margins/sectPr, or [Content_Types].xml.
Libraries (python-docx/openpyxl) are for READING; WRITES use direct XML
(lxml), because openpyxl drops charts/images and python-docx can alter parts
it does not know. For pure text swaps, patch the XML and repack byte-for-byte.

XLSX specifics: text may live in sharedStrings.xml or inline; formulas keep a
cached value that goes stale after edits → set fullCalcOnLoad="1" on calcPr or
recalculate with headless LibreOffice. Charts, pivots, validations and
conditional formatting survive ONLY if the workbook is not fully rewritten.
With .xlsm keep vbaProject.bin byte-identical.
PPTX specifics: text lives in a:t of slideN.xml and notesSlideN.xml; never
touch layouts/masters; reordering slides means editing sldIdLst + rels;
beware autofit when lengthening text.
PDF specifics — three levels: (a) structural ops (merge/split/rotate,
watermark, numbering, forms, annotations, redaction) → total fidelity with
pypdf/qpdf; (b) text micro-edits → PyMuPDF locates, redacts the area and
inserts with the same embedded font (similar-length, single-line only, no
paragraph reflow); (c) rewrites → edit the source .docx if available, else
PDF→DOCX→edit→export warning about fidelity loss. Scanned: OCR first. Save
with incremental update to avoid rewriting the original.
Other formats: ODF like OOXML (content.xml; mimetype FIRST entry,
uncompressed); .doc/.xls/.ppt convert to OOXML via LibreOffice, edit, convert
back (minor losses); md/txt/csv/json/html/tex edit directly; images via Pillow.
DOCX star option: return with tracked changes (w:del/w:ins + author/date) so
the student sees what changed.

FIVE-PHASE LOOP (mandatory): inspect (unpack, per-part text, inventory,
thumbnails) → plan (JSON list of atomic edits: part, locator, before, after,
reason; in approval mode the user sees this plan first) → execute (each edit
applied by a script saved in the job — reproducible/auditable recipe, never by
hand on the whole XML) → validate (structural + open + visual + textual, see
./validate.js) → report (file, change report, thumbnails of affected pages).
Models: Opus for planning/academic rewrites, Sonnet for mechanical edits,
Haiku for task classification. Max iterations + tokens per job; prompt cache
on the prefix (rules + skills).`;

const FORMAT_NOTES = Object.freeze({
  docx: 'DOCX: a sentence may be split across several w:r (rsid, spell-check). Join runs, locate the string, rewrite preserving the w:rPr of the first affected run. Text also lives in header*.xml, footer*.xml, footnotes.xml, comments.xml and drawings.',
  xlsx: 'XLSX: never open with data_only=True and save (formulas lost). Reuse cell styles; never rebuild tcPr/tblPr equivalents.',
  pptx: 'PPTX: edit runs, never shape.text (nukes formatting). New slides use the deck OWN layouts.',
  pdf: 'PDF: not a document but a page description. Prefer structural ops; micro-edits only same-font/similar-length.',
});

function buildSurgicalPromptAddition({ instruction = '', formats = [] } = {}) {
  const reformat = isReformateoRequest(instruction);
  const notes = (Array.isArray(formats) ? formats : [])
    .map((f) => FORMAT_NOTES[String(f || '').toLowerCase()])
    .filter(Boolean);
  const guard = reformat
    ? 'REFORMAT MODE explicitly requested by the user: style/theme/layout changes are allowed for this run.'
    : 'FORMAT GUARD active: styles.xml, numbering.xml, theme, layouts, masters, margins/sectPr and [Content_Types].xml are OFF-LIMITS unless the user says "modo reformateo".';
  return [SURGICAL_RULES, guard, ...notes].join('\n\n');
}

module.exports = {
  FORBIDDEN_PARTS,
  SKILL_ORDER,
  SURGICAL_RULES,
  FORMAT_NOTES,
  REFORMATEO_RE,
  isReformateoRequest,
  buildSurgicalPromptAddition,
};
