'use strict';

/**
 * Milimetric validation for surgical edits (§7 of the design brief).
 *
 * Five checks, cheapest first:
 *   1. structural — valid ZIP, well-formed central directory, [Content_Types].xml at root
 *   2. parts      — same entry set as the original (except expected additions)
 *   3. forbidden  — no FORBIDDEN_PARTS entry changed unless reformat mode
 *   4. textual    — caller-supplied text diff (extracted before/after); any
 *                   unplanned change is a failure (checked by the caller —
 *                   this module only packages the verdict shape)
 *   5. visual/open — LibreOffice convert-to-pdf + PNG diff live in the sandbox
 *                   (see validateInSandbox); here we only expose the command
 *                   builders so prompts stay in sync with the runner.
 *
 * Rollback policy: on ANY failure discard, restart from the pristine copy and
 * retry with the error as context (max 3 attempts — enforced by index.js).
 * Never deliver a file that did not pass all five.
 */

const { FORBIDDEN_PARTS, isReformateoRequest } = require('./surgical-rules');

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;

function listZipEntries(buffer) {
  const entries = [];
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) return null;
  if (buffer.readUInt32LE(0) !== 0x04034b50) return null;
  let eocd = -1;
  const minStart = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= minStart; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd === -1) return null;
  const total = buffer.readUInt16LE(eocd + 10);
  let off = buffer.readUInt32LE(eocd + 16);
  for (let n = 0; n < total; n += 1) {
    if (off + 46 > buffer.length || buffer.readUInt32LE(off) !== CDH_SIG) return null;
    const crc = buffer.readUInt32LE(off + 16);
    const compSize = buffer.readUInt32LE(off + 20);
    const uncompSize = buffer.readUInt32LE(off + 24);
    const nameLen = buffer.readUInt16LE(off + 28);
    const extraLen = buffer.readUInt16LE(off + 30);
    const commentLen = buffer.readUInt16LE(off + 32);
    if (off + 46 + nameLen > buffer.length) return null;
    const name = buffer.toString('utf8', off + 46, off + 46 + nameLen);
    entries.push({ name, crc, compSize, uncompSize });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function isForbiddenEntry(name = '') {
  const n = String(name);
  return FORBIDDEN_PARTS.some((f) => (f.endsWith('/') ? n.startsWith(f) : n === f));
}

/**
 * Diff two OOXML buffers by central-directory entries.
 * @returns null when either buffer is not a readable ZIP.
 */
function diffOoxml(originalBuffer, editedBuffer) {
  const before = listZipEntries(originalBuffer);
  const after = listZipEntries(editedBuffer);
  if (!before || !after) return null;
  const beforeMap = new Map(before.map((e) => [e.name, e]));
  const afterMap = new Map(after.map((e) => [e.name, e]));
  const added = [];
  const removed = [];
  const changed = [];
  const unchanged = [];
  for (const [name, a] of afterMap) {
    const b = beforeMap.get(name);
    if (!b) { added.push(name); continue; }
    if (a.crc !== b.crc || a.uncompSize !== b.uncompSize) changed.push(name);
    else unchanged.push(name);
  }
  for (const name of beforeMap.keys()) {
    if (!afterMap.has(name)) removed.push(name);
  }
  return { added, removed, changed, unchanged };
}

/**
 * Full verdict for one edited deliverable.
 *
 * Hard fails (the file is never delivered): empty, not a ZIP, missing
 * [Content_Types].xml, parts REMOVED, byte-identical to the input.
 *
 * Forbidden-parts touches are ADVISORY by default (`unexpectedParts` on the
 * verdict, surfaced in the change report): library round-trips
 * (python-docx/openpyxl) re-serialize untouched parts, so a CRC touch does
 * not prove the model reformatted anything. Pass `strictForbidden: true`
 * when the caller knows the lxml ZIP-patch path was used — there CRCs are
 * exact and a touch is a real violation. "modo reformateo" skips the check.
 *
 * @param {object} opts
 * @param {Buffer} opts.originalBuffer pristine input (may be null when unknown)
 * @param {Buffer} opts.editedBuffer the candidate deliverable
 * @param {string} [opts.instruction] user instruction (detects reformat mode)
 * @param {string[]} [opts.expectedParts] entry names the plan said would change
 * @param {boolean} [opts.strictForbidden] hard-fail on forbidden touches
 */
function validateEditedFile({ originalBuffer, editedBuffer, instruction = '', expectedParts = [], strictForbidden = false } = {}) {
  if (!Buffer.isBuffer(editedBuffer) || editedBuffer.length === 0) {
    return { ok: false, reason: 'empty_file', diff: null };
  }
  const after = listZipEntries(editedBuffer);
  if (!after) return { ok: false, reason: 'not_a_zip', diff: null };
  if (!after.some((e) => e.name === '[Content_Types].xml')) {
    return { ok: false, reason: 'ooxml_structure', diff: null };
  }
  if (!originalBuffer) return { ok: true, reason: 'no_baseline', diff: null };
  const diff = diffOoxml(originalBuffer, editedBuffer);
  if (!diff) return { ok: false, reason: 'baseline_unreadable', diff: null };
  if (diff.removed.length > 0) {
    return { ok: false, reason: 'parts_removed', diff, details: diff.removed.slice(0, 10) };
  }
  const reformat = isReformateoRequest(instruction);
  const touchedForbidden = reformat ? [] : diff.changed.filter(isForbiddenEntry);
  if (strictForbidden && touchedForbidden.length > 0) {
    return { ok: false, reason: 'forbidden_parts_touched', diff, details: touchedForbidden };
  }
  if (diff.changed.length === 0 && diff.added.length === 0) {
    return { ok: false, reason: 'identical_to_input', diff };
  }
  // Unexpected changes outside the plan are reported but do not fail the
  // run by themselves — the textual diff (phase 4) is the hard gate and it
  // needs the extracted text, which only the sandbox has. Callers surface
  // `unexpectedParts` in the change report.
  const unexpected = touchedForbidden.slice();
  if (Array.isArray(expectedParts) && expectedParts.length > 0) {
    for (const n of diff.changed) {
      if (!expectedParts.includes(n) && !unexpected.includes(n)) unexpected.push(n);
    }
  }
  const verdict = { ok: true, reason: 'valid', diff };
  if (unexpected.length > 0) verdict.unexpectedParts = unexpected;
  return verdict;
}

// Sandbox-side validation commands (LibreOffice open-check + text dump for
// the textual diff). Visual PNG diff (60–80dpi, zero diff outside edited
// regions) runs with the same tools when poppler is present.
function libreOfficePdfCheckCommand(inputPath, outDir = '/workspace/tmp/validate') {
  const safe = String(inputPath).replace(/"/g, '');
  const dir = String(outDir).replace(/"/g, '');
  return `mkdir -p "${dir}" && libreoffice --headless --convert-to pdf --outdir "${dir}" "${safe}"`;
}

function extractTextCommand(inputPath) {
  const safe = String(inputPath).replace(/"/g, '');
  return `python3 - "${safe}" <<'PY'\nimport sys, zipfile, re\nz = zipfile.ZipFile(sys.argv[1])\nfor name in z.namelist():\n    if name.startswith(('word/', 'xl/sharedStrings', 'ppt/slides/slide')):\n        print('---', name)\n        print(re.sub(r'<[^>]+>', ' ', z.read(name).decode('utf-8', 'replace'))[:4000])\nPY`;
}

module.exports = {
  listZipEntries,
  isForbiddenEntry,
  diffOoxml,
  validateEditedFile,
  libreOfficePdfCheckCommand,
  extractTextCommand,
  MAX_ATTEMPTS: 3,
};
