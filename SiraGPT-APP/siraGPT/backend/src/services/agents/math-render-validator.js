/**
 * math-render-validator — closes the loop opened by phase 1 (OMML).
 *
 * The doc-generator can produce a DOCX, but until now nothing checked
 * that the equations the user asked for actually landed in the file.
 * This validator opens the rendered .docx, counts the OMML and image
 * elements, and reports back so the doc-generator (and the
 * processing-state machine) can refuse to mark a math-bearing
 * document as "Validado" when it shipped with zero formulas.
 *
 * Strict scope:
 *   - DOCX only (xlsx/pptx land in their own validators).
 *   - Static check — looks at word/document.xml, no rendering.
 *   - Pure: takes bytes, returns a plain JS object. No I/O.
 *
 * Public API:
 *   countMathElements(buffer)
 *     -> Promise<{ omath, drawings, ok, reason? }>
 *   detectMathIntent(prompt)
 *     -> boolean
 *   validateMathRender({ buffer, prompt, sourceText })
 *     -> Promise<{ ok, reason?, omath, drawings, mathExpected }>
 */

const JSZip = require('jszip');

// ── Math intent detection ──────────────────────────────────────────────
//
// Cheap regex against the user's prompt + the LLM's emitted Python
// snippet. We only need to know "did the prompt ask for math?" so we
// can decide whether 0 equations is a failure or just an expected
// non-math document.

const MATH_KEYWORDS_RE = new RegExp(
  [
    // Spanish
    'integral(?:es)?',
    'deriva(?:r|da|das|nte|ndo)',
    'ecuaci(?:ó|o)n(?:es)?',
    'f[óo]rmula(?:s)?',
    'matem[áa]tica',
    'c[áa]lculo',
    'matriz(?:es)?',
    'determinante',
    'autovalor(?:es)?',
    'eigenval',
    'cronbach',
    'correlaci[óo]n',
    'regresi[óo]n',
    'estad[íi]stica',
    'probabilidad',
    'distribuci[óo]n',
    // English
    'integral(?:s)?',
    'deriv(?:e|ed|atives?|ation)',
    'equation(?:s)?',
    'formula(?:s|e)?',
    'math(?:s|ematics)?',
    'calculus',
    'matrix|matrices',
    'eigen(?:value|vector)',
    'sum(?:mation)?',
    'sigma',
    // Direct math markers
    'apa_math\\s*\\(',
    '\\\\frac',
    '\\\\int',
    '\\\\sum',
    '\\\\sqrt',
    '\\$\\$',
  ].join('|'),
  'i',
);

function detectMathIntent(text) {
  if (!text || typeof text !== 'string') return false;
  return MATH_KEYWORDS_RE.test(text);
}

// ── DOCX inspection ────────────────────────────────────────────────────

async function countMathElements(buffer) {
  if (!buffer
    || (typeof buffer === 'string' && !buffer.length)
    || (Buffer.isBuffer(buffer) && buffer.length === 0)) {
    return { omath: 0, drawings: 0, ok: false, reason: 'empty_buffer' };
  }
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (err) {
    return { omath: 0, drawings: 0, ok: false, reason: `zip_open_failed: ${err.message || 'unknown'}` };
  }
  const docXmlEntry = zip.file('word/document.xml');
  if (!docXmlEntry) {
    return { omath: 0, drawings: 0, ok: false, reason: 'missing_document_xml' };
  }
  let xml;
  try {
    xml = await docXmlEntry.async('string');
  } catch (err) {
    return { omath: 0, drawings: 0, ok: false, reason: `xml_read_failed: ${err.message || 'unknown'}` };
  }
  // Plain regex — robust enough for an integrity check, infinitely
  // cheaper than spinning up a real XML parser. The trailing class
  // `[\s/>]` matches three legitimate continuations after the tag
  // name: a space (attrs follow), a `>` (no attrs), or a `/` (self-
  // closing). Without `/`, `<m:oMath/>` would be missed.
  const omath = (xml.match(/<m:oMath[\s/>]/g) || []).length;
  const drawings = (xml.match(/<w:drawing[\s/>]/g) || []).length;
  return { omath, drawings, ok: true };
}

// ── Top-level validator ────────────────────────────────────────────────

/**
 * Validate that the DOCX has rendered math when the upstream prompt
 * (and/or the LLM's Python snippet) asked for it.
 *
 * Returns:
 *   { ok: true,  mathExpected, omath, drawings }            — pass
 *   { ok: false, reason, mathExpected, omath, drawings }    — block
 *
 * Reason codes:
 *   - 'no_equations_rendered' — math was expected, file has 0 OMML
 *     and 0 image fallbacks.
 *   - the underlying open/parse error if the buffer wasn't readable.
 */
async function validateMathRender({ buffer, prompt, sourceText } = {}) {
  const counts = await countMathElements(buffer);
  const mathExpected = detectMathIntent(prompt) || detectMathIntent(sourceText);
  if (!counts.ok) {
    return { ok: false, reason: counts.reason, mathExpected, omath: 0, drawings: 0 };
  }
  if (mathExpected && counts.omath === 0 && counts.drawings === 0) {
    return {
      ok: false,
      reason: 'no_equations_rendered',
      mathExpected,
      omath: counts.omath,
      drawings: counts.drawings,
    };
  }
  return { ok: true, mathExpected, omath: counts.omath, drawings: counts.drawings };
}

module.exports = {
  countMathElements,
  detectMathIntent,
  validateMathRender,
};
