/**
 * pdf-render-validator — structural integrity check for generated PDFs.
 *
 * Phase 4 of the Validation Fabric. Where MathRenderValidator
 * (phase 2) gates DOCX content, this validator gates PDF integrity.
 * It refuses to mark a PDF artifact as "Validado" until at least
 * the file structure parses, the page count is non-zero, and
 * (when the prompt asked for content) the extracted text isn't
 * suspiciously empty.
 *
 * Static checks only — we do NOT spin up a headless browser here.
 * That render-correctness pass lives in the future
 * PreviewScreenshotValidator (Playwright). The trade-off:
 *   - Faster (~50 ms vs. ~2 s for a Playwright snapshot)
 *   - Always available — no Chromium dep in the deploy
 *   - Catches the failure mode that bites in production: a PDF that
 *     parses cleanly but has 0 pages, or a 0-page placeholder the
 *     LLM emitted when its template generation crashed.
 *
 * Public API:
 *   countPdfMetrics(buffer)
 *     -> Promise<{ ok, reason?, pages, textLength, sizeBytes, hasMagic }>
 *   validatePdfRender({ buffer, prompt, sourceText })
 *     -> Promise<{ ok, reason?, pages, textLength, sizeBytes,
 *                  contentExpected }>
 */

const PDF_MAGIC = Buffer.from('%PDF-');
const MIN_PDF_BYTES = 200;          // smaller than this is structurally impossible
const MIN_TEXT_CHARS_DEFAULT = 5;   // anything shorter is "essentially empty"

let _pdfParsePromise = null;
function loadPdfParse() {
  if (!_pdfParsePromise) {
    _pdfParsePromise = Promise.resolve()
      .then(() => require('pdf-parse'))
      .catch((err) => {
        // Reset so the next call retries — production deploys
        // sometimes hit an ENOENT on cold start before the FS is
        // mounted, and the second poll succeeds.
        _pdfParsePromise = null;
        throw err;
      });
  }
  return _pdfParsePromise;
}

function looksLikePdf(buffer) {
  if (!Buffer.isBuffer(buffer)) return false;
  if (buffer.length < MIN_PDF_BYTES) return false;
  // %PDF- can appear anywhere in the first 1 KB (some generators
  // prepend a UTF-8 BOM or whitespace; Adobe spec says first 1 KB).
  const head = buffer.slice(0, Math.min(buffer.length, 1024));
  return head.indexOf(PDF_MAGIC) >= 0;
}

async function countPdfMetrics(buffer) {
  if (!buffer || (Buffer.isBuffer(buffer) && buffer.length === 0)) {
    return { ok: false, reason: 'empty_buffer', pages: 0, textLength: 0, sizeBytes: 0, hasMagic: false };
  }
  const sizeBytes = Buffer.isBuffer(buffer) ? buffer.length : Buffer.byteLength(buffer);
  if (!looksLikePdf(buffer)) {
    return { ok: false, reason: 'pdf_magic_missing', pages: 0, textLength: 0, sizeBytes, hasMagic: false };
  }
  let parsed;
  try {
    const pdfParse = await loadPdfParse();
    parsed = await pdfParse(buffer, { max: 0 }); // max:0 = parse everything
  } catch (err) {
    return {
      ok: false,
      reason: `pdf_parse_failed: ${err.message || 'unknown'}`,
      pages: 0,
      textLength: 0,
      sizeBytes,
      hasMagic: true,
    };
  }
  const pages = Number.isFinite(parsed?.numpages) ? parsed.numpages : 0;
  const textLength = (parsed?.text || '').trim().length;
  if (pages <= 0) {
    return { ok: false, reason: 'zero_pages', pages, textLength, sizeBytes, hasMagic: true };
  }
  return { ok: true, pages, textLength, sizeBytes, hasMagic: true };
}

// ── Content-expectation detection ──────────────────────────────────────
//
// Most prompts that ask for a PDF expect actual content (a report,
// a contract, a writeup). A few legitimately don't — e.g. a "form
// PDF for the user to fill in" might ship blank fields with no body
// text. We only flag the "0 chars of text in a PDF the user wanted
// content from" case as a failure.

const CONTENT_HINT_RE = new RegExp(
  [
    // Spanish
    'informe',
    'reporte',
    'memoria',
    'tesis',
    'monograf[íi]a',
    'ensayo',
    'art[íi]culo',
    'documento',
    'contrato',
    'manual',
    'gu[íi]a',
    'curr[íi]culo|cv\\b',
    'redacta',
    'analiza',
    'descripci[óo]n',
    'res[úu]men',
    // English
    'report',
    'paper',
    'essay',
    'memo',
    'manual',
    'guide',
    'cv|resume',
    'description',
    'summary',
    'analysis',
    'writeup',
  ].join('|'),
  'i',
);

// Word-boundary anchored — without \b, the bare token "form" matched
// inside "in**form**e" / "in**form**ación" / "trans**form**a" and the
// validator silently flipped contentExpected=false on every report
// the user actually wanted body text in.
const FORM_HINT_RE = /\b(formulario|formularios|fillable|rellenable|plantilla\s+vac[íi]a|blank\s+template|fillable\s+pdf|pdf\s+form)\b/i;

function expectsTextContent(text) {
  if (!text || typeof text !== 'string') return false;
  if (FORM_HINT_RE.test(text)) return false;   // explicit form-only request
  return CONTENT_HINT_RE.test(text);
}

// ── Top-level validator ────────────────────────────────────────────────

async function validatePdfRender({ buffer, prompt, sourceText, minTextChars } = {}) {
  const metrics = await countPdfMetrics(buffer);
  const contentExpected = expectsTextContent(prompt) || expectsTextContent(sourceText);
  if (!metrics.ok) {
    return { ...metrics, contentExpected };
  }
  // When the prompt clearly asked for prose and the PDF came back
  // with no extractable text, that's the silent-failure mode: the
  // cover/header rendered but the body never made it into the
  // template. Surface it.
  const minChars = Number.isFinite(minTextChars) ? minTextChars : MIN_TEXT_CHARS_DEFAULT;
  if (contentExpected && metrics.textLength < minChars) {
    return {
      ok: false,
      reason: 'no_text_content',
      pages: metrics.pages,
      textLength: metrics.textLength,
      sizeBytes: metrics.sizeBytes,
      hasMagic: true,
      contentExpected,
    };
  }
  return { ...metrics, contentExpected };
}

module.exports = {
  countPdfMetrics,
  validatePdfRender,
  expectsTextContent,
  looksLikePdf,
};
