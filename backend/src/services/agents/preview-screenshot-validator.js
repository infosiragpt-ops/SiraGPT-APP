/**
 * preview-screenshot-validator — phase 7 of the Validation Fabric.
 *
 * Where the static validators (math / pdf / mime / pptx / xlsx)
 * confirm the *bytes* are well-formed, this validator launches
 * Playwright and confirms the user actually sees something when
 * the preview renders. Catches three classes of silent failure
 * the structural validators can't:
 *
 *   - htmlPreview that compiles to a blank page (mammoth got the
 *     XML but every element collapsed to an empty <p/>)
 *   - SVG with a viewBox that puts the whole drawing off-screen
 *   - PDF/HTML with rendering scripts that throw mid-paint
 *
 * Heavy operation (~500 ms cold start + ~200 ms per render +
 * Chromium binary on disk), so this validator is OPT-IN and
 * NON-BLOCKING by default. The caller supplies the input it wants
 * checked; the doc-pipeline's synchronous delivery path is not
 * affected. SelfRepairEngine (phase 9) is the intended driver: when
 * a static gate trips and we regenerate, it can ask this validator
 * to confirm the new artifact actually paints before re-delivery.
 *
 * Public API:
 *   validatePreviewScreenshot({ html, mimeType, format,
 *                               viewport, minPngBytes })
 *     -> Promise<{ ok, reason?, pngBytes, viewportWidth,
 *                  viewportHeight, durationMs, validatorAvailable }>
 *   isPlaywrightAvailable() -> Promise<boolean>
 */

const DEFAULT_VIEWPORT = { width: 800, height: 1000 };
const DEFAULT_MIN_PNG_BYTES = 5_000;   // a blank 800×1000 PNG is < 4 KB
const DEFAULT_NAVIGATION_TIMEOUT_MS = 8_000;

let _playwrightModule = null;
let _playwrightAvailable = null;

function loadPlaywright() {
  if (_playwrightModule !== null) return _playwrightModule;
  try {
    _playwrightModule = require('playwright');
  } catch {
    _playwrightModule = null;
  }
  return _playwrightModule;
}

async function isPlaywrightAvailable() {
  if (_playwrightAvailable !== null) return _playwrightAvailable;
  const pw = loadPlaywright();
  if (!pw || !pw.chromium || typeof pw.chromium.launch !== 'function') {
    _playwrightAvailable = false;
    return false;
  }
  // Try a fast launch + close to confirm the binary is on disk.
  // This is the failure mode CI runners hit when `npx playwright
  // install` was skipped: the lib loads but the chromium executable
  // is absent and `launch()` throws "Executable doesn't exist".
  let browser;
  try {
    browser = await pw.chromium.launch({ headless: true, args: ['--no-sandbox'] });
    _playwrightAvailable = true;
  } catch {
    _playwrightAvailable = false;
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* noop */ }
    }
  }
  return _playwrightAvailable;
}

/**
 * Validate that the supplied preview content paints something
 * non-blank inside Chromium.
 *
 * Modes:
 *   - { html: '<...>' }                 — sets the page HTML directly
 *   - { dataUrl: 'data:<mime>;base64,…' } — navigates to the data URL
 *   - { url: '<http(s)://…>' }           — navigates to the URL
 *
 * Heuristic: a successful render produces a screenshot that
 * compresses to >= minPngBytes. A blank-page screenshot at the
 * default viewport zlib-compresses to ~3 KB, well below the 5 KB
 * threshold.
 */
async function validatePreviewScreenshot({
  html,
  dataUrl,
  url,
  format,
  viewport = DEFAULT_VIEWPORT,
  minPngBytes = DEFAULT_MIN_PNG_BYTES,
  navigationTimeoutMs = DEFAULT_NAVIGATION_TIMEOUT_MS,
} = {}) {
  const inputs = [html, dataUrl, url].filter(Boolean);
  if (inputs.length === 0) {
    return {
      ok: false,
      reason: 'no_input',
      validatorAvailable: true,
      pngBytes: 0,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      durationMs: 0,
    };
  }

  const available = await isPlaywrightAvailable();
  if (!available) {
    // Fail-soft when Playwright isn't installed (dev machines that
    // skipped `npx playwright install`, CI runners on minimal
    // images). Return a recognisable status so the pipeline can
    // distinguish "validator unavailable" from "validator says no".
    return {
      ok: true,
      reason: 'validator_unavailable',
      validatorAvailable: false,
      pngBytes: 0,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      durationMs: 0,
    };
  }

  const pw = loadPlaywright();
  const startedAt = Date.now();
  let browser;
  try {
    browser = await pw.chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();

    if (html) {
      await page.setContent(String(html), {
        waitUntil: 'networkidle',
        timeout: navigationTimeoutMs,
      });
    } else {
      const target = dataUrl || url;
      await page.goto(target, { waitUntil: 'networkidle', timeout: navigationTimeoutMs });
    }

    // Tiny settle delay so just-loaded fonts / KaTeX render before
    // the screenshot snaps. Lower than the full networkidle wait.
    await page.waitForTimeout(150);

    const png = await page.screenshot({ type: 'png', fullPage: false });
    const pngBytes = png.length;
    const durationMs = Date.now() - startedAt;

    if (pngBytes < minPngBytes) {
      return {
        ok: false,
        reason: 'blank_render',
        validatorAvailable: true,
        pngBytes,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
        durationMs,
      };
    }

    return {
      ok: true,
      validatorAvailable: true,
      pngBytes,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    return {
      ok: false,
      reason: `render_failed: ${err.message || 'unknown'}`,
      validatorAvailable: true,
      pngBytes: 0,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      durationMs,
    };
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* already closed */ }
    }
  }
}

module.exports = {
  validatePreviewScreenshot,
  isPlaywrightAvailable,
  DEFAULT_VIEWPORT,
  DEFAULT_MIN_PNG_BYTES,
};
