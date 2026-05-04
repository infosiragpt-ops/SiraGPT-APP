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
  return {
    enabled: parseBoolean(env.CSP_ENABLED, true),
    reportOnly: parseBoolean(env.CSP_REPORT_ONLY, true),
    reportUri: String(env.CSP_REPORT_URI || '').trim() || null,
    directives: {
      connectSrc: parseList(env.CSP_CONNECT_SRC, DEFAULT_CONNECT_SRC),
      fontSrc: parseList(env.CSP_FONT_SRC, DEFAULT_FONT_SRC),
      frameSrc: parseList(env.CSP_FRAME_SRC, DEFAULT_FRAME_SRC),
      imgSrc: parseList(env.CSP_IMG_SRC, DEFAULT_IMG_SRC),
      objectSrc: parseList(env.CSP_OBJECT_SRC, DEFAULT_OBJECT_SRC),
      scriptSrc: parseList(env.CSP_SCRIPT_SRC, DEFAULT_SCRIPT_SRC),
      styleSrc: parseList(env.CSP_STYLE_SRC, DEFAULT_STYLE_SRC),
      baseUri: parseList(env.CSP_BASE_URI, DEFAULT_BASE_URI),
      frameAncestors: parseList(env.CSP_FRAME_ANCESTORS, DEFAULT_FRAME_ANCESTORS),
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
  return out;
}

module.exports = {
  resolveCspConfig,
  buildCspDirectives,
  DEFAULT_CONNECT_SRC,
  DEFAULT_FONT_SRC,
  DEFAULT_IMG_SRC,
  DEFAULT_SCRIPT_SRC,
  DEFAULT_STYLE_SRC,
  DEFAULT_OBJECT_SRC,
};
