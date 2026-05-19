'use strict';

/**
 * csp-policy — Content Security Policy directives for the backend.
 *
 * Why this exists separately from helmet's defaults:
 *   helmet ships with a sane default CSP, but it's tuned for
 *   classic server-rendered apps with no inline scripts. The
 *   siraGPT frontend (Next.js + Syncfusion + KaTeX + Mermaid +
 *   Plotly + several other widgets) injects inline styles and
 *   script tags as a matter of course. Turning helmet's default
 *   CSP on directly would brick the page.
 *
 *   The pragmatic path: ship CSP in **report-only** mode by
 *   default. The browser still reports violations to the configured
 *   endpoint (or to the console) but never blocks anything. After
 *   a few days of observed violations the operator can tighten the
 *   policy and flip CSP_REPORT_ONLY=false.
 *
 *   This module exposes:
 *     - resolveCspConfig(env): pure env→config helper
 *     - buildCspDirectives(config): returns the helmet `directives`
 *       object so index.js can pass it straight to `helmet({
 *       contentSecurityPolicy: { directives: ..., reportOnly: ...}
 *       })`. The policy is intentionally LOOSE on script-src /
 *       style-src by default (allows 'self' + 'unsafe-inline' +
 *       'unsafe-eval') because Next.js dev mode and Mermaid
 *       require both. A production deploy should override
 *       CSP_SCRIPT_SRC + CSP_STYLE_SRC to drop the unsafe-* tokens
 *       once we audit which inline content is unavoidable.
 *
 * What is NOT in scope:
 *   - Trusted Types: requires app-wide refactor of innerHTML
 *     consumers (we have several via TipTap + react-markdown +
 *     Syncfusion). Tracked as a separate phase.
 *   - Subresource Integrity (SRI) for the KaTeX / Syncfusion CDN
 *     scripts: Next.js doesn't emit `integrity` for static
 *     `<script>` tags by default. Tracked separately.
 */

const DEFAULT_CONNECT_SRC = ["'self'"];
const DEFAULT_FONT_SRC = ["'self'", 'data:'];
const DEFAULT_FRAME_SRC = ["'self'"];
const DEFAULT_IMG_SRC = ["'self'", 'data:', 'blob:', 'https:'];
const DEFAULT_OBJECT_SRC = ["'none'"];
const DEFAULT_SCRIPT_SRC = ["'self'", "'unsafe-inline'", "'unsafe-eval'"];
const DEFAULT_STYLE_SRC = ["'self'", "'unsafe-inline'", 'https:'];
const DEFAULT_BASE_URI = ["'self'"];
const DEFAULT_FRAME_ANCESTORS = ["'self'"];
const DEFAULT_FORM_ACTION = ["'self'"];
const DEFAULT_WORKER_SRC = ["'self'", 'blob:'];

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parseList(raw, fallback) {
  if (!raw) return fallback.slice();
  return String(raw)
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * resolveCspConfig — env → config. Defaults are deliberately
 * loose so a fresh deploy doesn't break inline content; the
 * reportOnly default is true so the same fresh deploy generates
 * actionable telemetry instead of a mystery white page.
 */
function resolveCspConfig(env = process.env) {
  // CSP_STRICT=true switches to enforced mode with a tightened
  // directive set (no 'unsafe-eval', frame-ancestors 'none',
  // upgrade-insecure-requests). reportOnly defaults to FALSE in strict
  // mode unless the operator explicitly opts back into report-only.
  // CSP_USE_NONCE=true enables per-request nonces for script-src/style-src
  // (see `buildCspDirectivesWithNonce`).
  const strict = parseBoolean(env.CSP_STRICT, false);
  const useNonce = parseBoolean(env.CSP_USE_NONCE, false);
  const reportOnlyDefault = strict ? false : true;
  return {
    enabled: parseBoolean(env.CSP_ENABLED, true),
    reportOnly: parseBoolean(env.CSP_REPORT_ONLY, reportOnlyDefault),
    strict,
    useNonce,
    upgradeInsecure: parseBoolean(env.CSP_UPGRADE_INSECURE, strict),
    reportUri: String(env.CSP_REPORT_URI || '').trim() || null,
    directives: {
      connectSrc: parseList(env.CSP_CONNECT_SRC, DEFAULT_CONNECT_SRC),
      fontSrc: parseList(env.CSP_FONT_SRC, DEFAULT_FONT_SRC),
      frameSrc: parseList(env.CSP_FRAME_SRC, DEFAULT_FRAME_SRC),
      imgSrc: parseList(env.CSP_IMG_SRC, DEFAULT_IMG_SRC),
      objectSrc: parseList(env.CSP_OBJECT_SRC, DEFAULT_OBJECT_SRC),
      scriptSrc: parseList(
        env.CSP_SCRIPT_SRC,
        strict ? ["'self'", "'unsafe-inline'"] : DEFAULT_SCRIPT_SRC
      ),
      styleSrc: parseList(env.CSP_STYLE_SRC, DEFAULT_STYLE_SRC),
      baseUri: parseList(env.CSP_BASE_URI, DEFAULT_BASE_URI),
      frameAncestors: parseList(
        env.CSP_FRAME_ANCESTORS,
        strict ? ["'none'"] : DEFAULT_FRAME_ANCESTORS
      ),
      formAction: parseList(env.CSP_FORM_ACTION, DEFAULT_FORM_ACTION),
      workerSrc: parseList(env.CSP_WORKER_SRC, DEFAULT_WORKER_SRC),
    },
  };
}

/**
 * buildCspDirectives — produce the directives object helmet
 * expects. Helmet flattens these into the actual CSP header.
 *
 * Notes:
 *   - default-src is set to the same value as connect-src as a
 *     conservative fallback for any directive the policy doesn't
 *     enumerate explicitly. Browsers fall back to default-src
 *     for unknown directives.
 *   - report-uri (deprecated but widely supported) and report-to
 *     (modern replacement) are both emitted when CSP_REPORT_URI
 *     is set so old + new browsers agree.
 *   - upgrade-insecure-requests is NOT included by default
 *     because dev runs over http://localhost. Production deploys
 *     can opt in via CSP_UPGRADE_INSECURE=true.
 */
function buildCspDirectives(config) {
  const d = config.directives;
  const out = {
    defaultSrc: ["'self'"],
    connectSrc: d.connectSrc,
    fontSrc: d.fontSrc,
    frameSrc: d.frameSrc,
    imgSrc: d.imgSrc,
    objectSrc: d.objectSrc,
    scriptSrc: d.scriptSrc,
    styleSrc: d.styleSrc,
    baseUri: d.baseUri,
    frameAncestors: d.frameAncestors,
    formAction: d.formAction,
    workerSrc: d.workerSrc,
  };
  if (config.reportUri) {
    // helmet's CSP reads `reportUri` (camelCase) and emits both
    // the legacy `report-uri` directive and the newer `report-to`
    // when paired with a Reporting-Endpoints header set elsewhere.
    out.reportUri = [config.reportUri];
  }
  if (config.upgradeInsecure) {
    // helmet expects an empty array to emit a flag directive
    out.upgradeInsecureRequests = [];
  }
  return out;
}

/**
 * cspNonceMiddleware — generates a per-request crypto nonce and
 * exposes it on `res.locals.cspNonce` so views can attach it to
 * `<script nonce="…">` / `<style nonce="…">` tags. Pair with
 * `buildCspDirectivesWithNonce` to bind the directives to the value.
 */
function cspNonceMiddleware() {
  const crypto = require('crypto');
  return function cspNonce(req, res, next) {
    res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
    next();
  };
}

/**
 * buildCspDirectivesWithNonce — like `buildCspDirectives` but appends
 * the per-request nonce token to script-src/style-src. Returns a
 * function helmet can call per-request (helmet supports function
 * values for directives).
 */
function buildCspDirectivesWithNonce(config) {
  const base = buildCspDirectives(config);
  return {
    ...base,
    scriptSrc: [
      ...base.scriptSrc,
      (req, res) => `'nonce-${res.locals.cspNonce}'`,
    ],
    styleSrc: [
      ...base.styleSrc,
      (req, res) => `'nonce-${res.locals.cspNonce}'`,
    ],
  };
}

module.exports = {
  resolveCspConfig,
  buildCspDirectives,
  buildCspDirectivesWithNonce,
  cspNonceMiddleware,
  DEFAULT_CONNECT_SRC,
  DEFAULT_FONT_SRC,
  DEFAULT_IMG_SRC,
  DEFAULT_SCRIPT_SRC,
  DEFAULT_STYLE_SRC,
  DEFAULT_OBJECT_SRC,
};
