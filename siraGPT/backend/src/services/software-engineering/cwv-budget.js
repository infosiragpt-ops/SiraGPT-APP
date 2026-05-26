/**
 * cwv-budget — offline Core Web Vitals budget checker.
 *
 * Input: a rendered HTML string + an optional asset-size manifest
 *        (bytes per URL). We do NOT fetch over the network — the
 *        caller may pass sizes from their CDN, bundler, or a prior
 *        crawl. Missing sizes are treated as unknown.
 *
 * Budgets (Google's recommended "good" thresholds):
 *   - Total JS bytes (gzipped, estimate): ≤ 170 KB
 *   - Total CSS bytes:                    ≤ 100 KB
 *   - Total image bytes (above the fold): ≤ 1.0 MB
 *   - Render-blocking resources count:    ≤ 4
 *   - Number of third-party origins:      ≤ 3
 *   - Image <img> without width/height:    each adds CLS risk
 *   - Hero <img> without loading="eager":  LCP risk
 *   - Non-hero <img> without loading="lazy"+decoding="async": low
 *
 * All thresholds are overridable via `budgets`.
 *
 * Output matches the ValidationFabric finding envelope.
 */

const DEFAULT_BUDGETS = Object.freeze({
  js_bytes: 170 * 1024,
  css_bytes: 100 * 1024,
  image_bytes: 1024 * 1024,
  render_blocking_count: 4,
  third_party_origins: 3,
});

const TAG_RE = {
  script: /<script\b([^>]*)>([\s\S]*?)<\/script>/gi,
  link: /<link\b([^>]*)\/?>/gi,
  img: /<img\b([^>]*)\/?>/gi,
  style: /<style\b([^>]*)>([\s\S]*?)<\/style>/gi,
};

function analyzeBudget({ html, siteOrigin = null, assetSizes = {}, budgets = {}, options = {} } = {}) {
  if (typeof html !== "string" || html.trim().length === 0) {
    return shellBad("analyzeBudget: html (non-empty string) required");
  }
  const BUDGETS = { ...DEFAULT_BUDGETS, ...budgets };
  const findings = [];

  const scripts = collectAll(html, "script");
  const links = collectAll(html, "link");
  const imgs = collectAll(html, "img");
  const styles = collectAll(html, "style");

  const origin = siteOrigin ? stripTrailingSlash(siteOrigin) : null;

  // ── Bytes estimation ───────────────────────────────────────────────
  let jsBytes = 0;
  let cssBytes = 0;
  let imageBytes = 0;
  const thirdPartyOrigins = new Set();
  let renderBlocking = 0;

  // Inline <style> and <script> contribute raw bytes
  for (const s of styles) cssBytes += (s.inner || "").length;
  for (const s of scripts) {
    if (!s.attrs.src) jsBytes += (s.inner || "").length;
  }

  for (const s of scripts) {
    const src = s.attrs.src;
    if (!src) continue;
    jsBytes += lookupSize(assetSizes, src);
    if (isThirdParty(src, origin)) thirdPartyOrigins.add(originOf(src));
    const isAsync = "async" in s.attrs || "defer" in s.attrs || (s.attrs.type || "") === "module";
    if (!isAsync) renderBlocking += 1;
  }

  for (const l of links) {
    const rel = (l.attrs.rel || "").toLowerCase();
    const href = l.attrs.href || "";
    if (rel === "stylesheet" && href) {
      cssBytes += lookupSize(assetSizes, href);
      if (isThirdParty(href, origin)) thirdPartyOrigins.add(originOf(href));
      renderBlocking += 1;
    }
  }

  for (const img of imgs) {
    const src = img.attrs.src || "";
    imageBytes += lookupSize(assetSizes, src);
    if (isThirdParty(src, origin)) thirdPartyOrigins.add(originOf(src));
  }

  if (jsBytes > BUDGETS.js_bytes) {
    findings.push(mk("high", "js_budget_exceeded", `JS bytes ${jsBytes} exceed budget ${BUDGETS.js_bytes}. Target: ≤ ${(BUDGETS.js_bytes / 1024).toFixed(0)} KB.`));
  }
  if (cssBytes > BUDGETS.css_bytes) {
    findings.push(mk("medium", "css_budget_exceeded", `CSS bytes ${cssBytes} exceed budget ${BUDGETS.css_bytes}. Target: ≤ ${(BUDGETS.css_bytes / 1024).toFixed(0)} KB.`));
  }
  if (imageBytes > BUDGETS.image_bytes) {
    findings.push(mk("medium", "image_budget_exceeded", `Image bytes ${imageBytes} exceed budget ${BUDGETS.image_bytes}. Target: ≤ ${(BUDGETS.image_bytes / 1024 / 1024).toFixed(1)} MB.`));
  }
  if (renderBlocking > BUDGETS.render_blocking_count) {
    findings.push(mk("medium", "render_blocking_excess", `${renderBlocking} render-blocking resources (budget ${BUDGETS.render_blocking_count}). Move to async/defer or preload.`));
  }
  if (thirdPartyOrigins.size > BUDGETS.third_party_origins) {
    findings.push(mk("low", "too_many_third_parties", `${thirdPartyOrigins.size} third-party origins referenced — each adds DNS + TLS round-trips.`));
  }

  // ── CLS risk: images without width/height ──────────────────────────
  let clsRisk = 0;
  for (const img of imgs) {
    const hasW = "width" in img.attrs;
    const hasH = "height" in img.attrs;
    if (!(hasW && hasH)) clsRisk += 1;
  }
  if (clsRisk > 0) {
    findings.push(mk("low", "cls_risk_images_without_dims", `${clsRisk} <img> element(s) missing width/height — each reserves zero space until loaded, causing CLS.`));
  }

  // ── LCP risk: first large image without loading="eager" ────────────
  if (imgs.length > 0) {
    const first = imgs[0];
    const loading = (first.attrs.loading || "").toLowerCase();
    if (loading === "lazy") {
      findings.push(mk("medium", "lcp_hero_lazy", "First <img> has loading=\"lazy\" — if this image is the LCP element, it will load late."));
    }
  }

  // ── Non-hero images should be lazy/decoding=async ──────────────────
  if (imgs.length >= 4) {
    let nonLazy = 0;
    for (let i = 1; i < imgs.length; i++) {
      const loading = (imgs[i].attrs.loading || "").toLowerCase();
      if (loading !== "lazy") nonLazy += 1;
    }
    if (nonLazy >= Math.max(3, Math.floor(imgs.length * 0.7))) {
      findings.push(mk("low", "non_hero_not_lazy", `${nonLazy} non-hero <img> without loading="lazy" — defer below-fold images.`));
    }
  }

  const counts = countBySeverity(findings);
  return {
    ok: counts.high === 0 && counts.critical === 0,
    findings,
    counts,
    stats: {
      js_bytes: jsBytes,
      css_bytes: cssBytes,
      image_bytes: imageBytes,
      render_blocking_count: renderBlocking,
      third_party_origins: thirdPartyOrigins.size,
      scripts: scripts.length,
      stylesheets: links.filter(l => (l.attrs.rel || "").toLowerCase() === "stylesheet").length,
      images: imgs.length,
      inline_styles_bytes: styles.reduce((a, s) => a + (s.inner || "").length, 0),
    },
    budgets: BUDGETS,
  };
}

function collectAll(html, tag) {
  const re = TAG_RE[tag];
  if (!re) return [];
  const results = [];
  re.lastIndex = 0;
  let m;
  if (tag === "script" || tag === "style") {
    while ((m = re.exec(html)) !== null) {
      results.push({ tag, attrs: parseAttrs(m[1]), inner: m[2] || "" });
    }
  } else {
    while ((m = re.exec(html)) !== null) {
      results.push({ tag, attrs: parseAttrs(m[1]), inner: "" });
    }
  }
  return results;
}

function parseAttrs(raw) {
  const out = {};
  const re = /(\w[\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const key = m[1].toLowerCase().replace(/-/g, "");
    const val = m[2] ?? m[3] ?? m[4] ?? "";
    out[key] = val;
  }
  const boolRe = /(?<=^|\s)([a-zA-Z][\w-]*)(?=(\s|$))/g;
  let b;
  while ((b = boolRe.exec(raw)) !== null) {
    const key = b[1].toLowerCase().replace(/-/g, "");
    if (!(key in out)) out[key] = "";
  }
  return out;
}

function lookupSize(map, url) {
  if (!url) return 0;
  if (url in map) return numberOr0(map[url]);
  // allow lookup by basename if full URL isn't in the map
  const base = basename(url);
  if (base && base in map) return numberOr0(map[base]);
  return 0;
}

function numberOr0(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function basename(url) {
  const clean = url.split(/[?#]/)[0];
  const parts = clean.split("/");
  return parts[parts.length - 1] || null;
}

function isThirdParty(url, origin) {
  if (!url) return false;
  if (url.startsWith("/") || url.startsWith("#")) return false;
  const o = originOf(url);
  if (!o) return false;
  if (!origin) return true;
  return o !== origin;
}

function originOf(url) {
  try {
    if (!/^https?:/i.test(url)) return null;
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch (_e) {
    return null;
  }
}

function stripTrailingSlash(s) {
  return String(s).replace(/\/+$/, "");
}

function countBySeverity(findings) {
  const out = { info: 0, low: 0, medium: 0, high: 0, critical: 0 };
  for (const f of findings) out[f.severity] = (out[f.severity] || 0) + 1;
  return out;
}

function mk(severity, code, detail) {
  return { severity, code, detail };
}

function shellBad(msg) {
  return {
    ok: false,
    findings: [{ severity: "high", code: "bad_input", detail: msg }],
    counts: { info: 0, low: 0, medium: 0, high: 1, critical: 0 },
    stats: {},
    budgets: DEFAULT_BUDGETS,
  };
}

module.exports = {
  analyzeBudget,
  DEFAULT_BUDGETS,
};
