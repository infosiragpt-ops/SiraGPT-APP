'use strict';

/**
 * pdf-fonts — Unicode font resolution for generated PDFs.
 *
 * PDFKit's built-in fonts (Helvetica, Times, Courier) are WinAnsi-only:
 * every non-Latin-1 character — typographic quotes, em dashes, Greek
 * letters in formulas, math symbols, non-Latin scripts — is silently
 * corrupted in every PDF we generate. Registering an embedded TTF makes
 * the text layer correct AND selectable (the extraction path reads the
 * embedded cmap), at the cost of bundling one ~740 KB font.
 *
 * Resolution order:
 *   1. SIRAGPT_PDF_FONT_PATH (explicit override)
 *   2. Bundled DejaVu Sans (backend/assets/fonts/DejaVuSans.ttf)
 *   3. Well-known system font locations (DejaVu / Liberation / Noto Sans
 *      on Linux images; Arial Unicode on macOS dev machines)
 *   4. null → caller falls back to Helvetica with a warning
 */

const fs = require('fs');
const path = require('path');

const BUNDLED_FONT_PATH = path.join(__dirname, '..', '..', '..', 'assets', 'fonts', 'DejaVuSans.ttf');

// First existing match wins. Ordered by coverage then availability:
// DejaVu/Liberation ship in most Docker base images and cover Latin
// Extended + Greek + math operators; Noto Sans covers even more but is
// less commonly preinstalled under this exact filename.
const SYSTEM_CANDIDATES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  '/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf',
  '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
];

let _cachedPath;
let _cachedExists = undefined;

function isReadableFile(p) {
  if (_cachedExists === undefined || _cachedExists.path !== p) {
    let ok = false;
    try {
      ok = Boolean(p) && fs.statSync(p).isFile() && fs.statSync(p).size > 10000;
    } catch {
      ok = false;
    }
    _cachedExists = { path: p, ok };
  }
  return _cachedExists.ok;
}

/**
 * Resolve the best available Unicode TTF path, or null when none exists.
 * Result is cached for the process lifetime; set SIRAGPT_PDF_NO_FONT_CACHE=1
 * in tests to re-resolve on every call.
 */
function resolveUnicodeFontPath(env = process.env) {
  if (String(env.SIRAGPT_PDF_NO_FONT_CACHE || '') === '1') _cachedPath = undefined;
  if (_cachedPath !== undefined) return _cachedPath;

  const explicit = String(env.SIRAGPT_PDF_FONT_PATH || '').trim();
  if (explicit && isReadableFile(explicit)) {
    _cachedPath = explicit;
    return _cachedPath;
  }
  if (isReadableFile(BUNDLED_FONT_PATH)) {
    _cachedPath = BUNDLED_FONT_PATH;
    return _cachedPath;
  }
  for (const candidate of SYSTEM_CANDIDATES) {
    if (isReadableFile(candidate)) {
      _cachedPath = candidate;
      return _cachedPath;
    }
  }
  _cachedPath = null;
  return _cachedPath;
}

function clearFontCacheForTests() {
  _cachedPath = undefined;
  _cachedExists = undefined;
}

let _cachedFont = undefined;

function loadFontBuffer(p) {
  if (_cachedFont && _cachedFont.path === p) return _cachedFont;
  try {
    const buffer = fs.readFileSync(p);
    _cachedFont = { path: p, buffer };
    return _cachedFont;
  } catch {
    return null;
  }
}

/**
 * Register a Unicode font on a PDFKit document. Returns
 * { fontPath: string|null, embedded: boolean } — `embedded=false` means
 * the caller keeps Helvetica and the output stays WinAnsi-only (same as
 * the historical behaviour).
 *
 * The TTF is passed to pdfkit as a pre-read Buffer: pdfkit's path-based
 * `doc.font(path)` loads asynchronously, so a fast `doc.end()` can flush
 * pages before the font program is embedded and produce a corrupt file
 * ("unterminated string" / broken xref). A Buffer is parsed synchronously.
 */
function registerUnicodeFont(doc, env = process.env) {
  const fontPath = resolveUnicodeFontPath(env);
  if (!fontPath) {
    console.warn(
      '[pdf-fonts] no Unicode TTF found — PDF will use Helvetica (WinAnsi only); ' +
      'non-Latin-1 characters will be corrupted. Bundle backend/assets/fonts/DejaVuSans.ttf ' +
      'or set SIRAGPT_PDF_FONT_PATH.'
    );
    return { fontPath: null, embedded: false };
  }
  try {
    const loaded = loadFontBuffer(fontPath);
    if (!loaded) throw new Error('font file unreadable');
    doc.font(loaded.buffer);
    return { fontPath, embedded: true };
  } catch (err) {
    console.warn(`[pdf-fonts] failed to load font ${fontPath}: ${err.message} — falling back to Helvetica`);
    return { fontPath: null, embedded: false };
  }
}

/** Convenience wrapper: register the font, run `fn`, restore defaults. */
async function withUnicodeFont(doc, fn, env = process.env) {
  const result = registerUnicodeFont(doc, env);
  try {
    return await fn(result);
  } finally {
    // PDFKit has no "unset font"; the document is short-lived per render,
    // so simply leaving the registered font in place is safe.
  }
}

module.exports = {
  BUNDLED_FONT_PATH,
  SYSTEM_CANDIDATES,
  resolveUnicodeFontPath,
  registerUnicodeFont,
  withUnicodeFont,
  clearFontCacheForTests,
};
