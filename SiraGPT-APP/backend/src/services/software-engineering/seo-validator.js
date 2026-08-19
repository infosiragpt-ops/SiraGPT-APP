/**
 * seo-validator — deterministic SEO quality gate for a rendered HTML
 * document. Pure string parsing, zero deps. Designed to be safe to
 * run on untrusted HTML in the backend.
 *
 * Checks performed (severity in parens):
 *   - title present + 10–65 chars                          (high)
 *   - meta description 50–160 chars                        (medium)
 *   - <html lang="..">                                      (medium)
 *   - canonical link rel="canonical" href=...               (medium)
 *   - Open Graph: og:title, og:description, og:image, og:type (medium)
 *   - Twitter card: twitter:card, twitter:title, twitter:description (low)
 *   - robots meta not set to "noindex" without an explicit override (medium)
 *   - single <h1>                                           (medium)
 *   - viewport meta                                         (medium)
 *   - charset meta                                          (low)
 *   - structured data: at least one <script type="application/ld+json">
 *     parses + has @context "schema.org"                    (low)
 *   - internal links use descriptive anchor text (not "click here") (low)
 *
 * Output shape matches the ValidationFabric finding envelope so the
 * QA Board can aggregate it directly.
 */

const TITLE_MIN = 10;
const TITLE_MAX = 65;
const DESC_MIN = 50;
const DESC_MAX = 160;

const META_ATTR = /<meta\s+([^>]+?)\s*\/?>/gi;
const LINK_ATTR = /<link\s+([^>]+?)\s*\/?>/gi;
const TITLE_TAG = /<title[^>]*>([\s\S]*?)<\/title>/i;
const H1_TAG = /<h1[^>]*>[\s\S]*?<\/h1>/gi;
const HTML_LANG = /<html\b[^>]*\blang\s*=\s*["']([^"']+)["']/i;
const SCRIPT_LDJSON = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
const ANCHOR_TAG = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
const VAGUE_ANCHORS = new Set(["click here", "read more", "here", "more", "learn more", "click"]);

/**
 * @param {object} args
 * @param {string} args.html — the rendered HTML string
 * @param {object} [args.options]
 * @param {boolean} [args.options.allowNoindex=false]
 * @returns {{ok, findings, stats, counts, meta}}
 */
function validateSeo({ html, options = {} } = {}) {
  const findings = [];
  if (typeof html !== "string" || html.trim().length === 0) {
    return shellBad("validateSeo: html (non-empty string) required");
  }

  const metas = parseMetas(html);
  const links = parseLinks(html);

  const titleMatch = TITLE_TAG.exec(html);
  const title = titleMatch ? stripTags(titleMatch[1]).trim() : null;
  if (!title) {
    findings.push(mk("high", "title_missing", "No <title> element found."));
  } else if (title.length < TITLE_MIN) {
    findings.push(mk("high", "title_too_short", `<title> is ${title.length} chars; recommended ≥ ${TITLE_MIN}.`));
  } else if (title.length > TITLE_MAX) {
    findings.push(mk("medium", "title_too_long", `<title> is ${title.length} chars; recommended ≤ ${TITLE_MAX}. Longer titles are truncated in SERPs.`));
  }

  const desc = metaContent(metas, { name: "description" });
  if (!desc) {
    findings.push(mk("medium", "meta_description_missing", "No <meta name=\"description\">."));
  } else if (desc.length < DESC_MIN) {
    findings.push(mk("low", "meta_description_too_short", `description is ${desc.length} chars; recommended ≥ ${DESC_MIN}.`));
  } else if (desc.length > DESC_MAX) {
    findings.push(mk("low", "meta_description_too_long", `description is ${desc.length} chars; recommended ≤ ${DESC_MAX}.`));
  }

  const langMatch = HTML_LANG.exec(html);
  if (!langMatch) {
    findings.push(mk("medium", "html_lang_missing", "<html> has no lang attribute — crawlers and screen readers cannot determine document language."));
  }

  const canonical = links.find(l => (l.rel || "").toLowerCase() === "canonical" && l.href);
  if (!canonical) {
    findings.push(mk("medium", "canonical_missing", "No <link rel=\"canonical\"> found — duplicate-content risk."));
  }

  for (const key of ["og:title", "og:description", "og:image", "og:type"]) {
    if (!metaContent(metas, { property: key })) {
      findings.push(mk("medium", `og_${key.replace(/[:\-]/g, "_")}_missing`, `Open Graph ${key} is missing — social shares will render poorly.`));
    }
  }

  for (const key of ["twitter:card", "twitter:title", "twitter:description"]) {
    if (!metaContent(metas, { name: key })) {
      findings.push(mk("low", `twitter_${key.split(":")[1]}_missing`, `Twitter card ${key} missing.`));
    }
  }

  const robots = metaContent(metas, { name: "robots" }) || "";
  if (/\bnoindex\b/i.test(robots) && !options.allowNoindex) {
    findings.push(mk("high", "robots_noindex", "meta robots is \"noindex\" — page will be excluded from search results."));
  }

  const h1s = html.match(H1_TAG) || [];
  if (h1s.length === 0) {
    findings.push(mk("medium", "h1_missing", "No <h1> element on the page."));
  } else if (h1s.length > 1) {
    findings.push(mk("medium", "h1_multiple", `${h1s.length} <h1> elements found — recommend exactly one.`));
  }

  if (!metaContent(metas, { name: "viewport" })) {
    findings.push(mk("medium", "viewport_missing", "<meta name=\"viewport\"> is missing — layout will break on mobile."));
  }

  const hasCharset = metas.some(m => m.charset || (m.httpEquiv || "").toLowerCase() === "content-type");
  if (!hasCharset) {
    findings.push(mk("low", "charset_missing", "No <meta charset=..>; some browsers may guess the encoding."));
  }

  const ldjson = extractLdJson(html);
  const structuredOk = ldjson.some(x => x && typeof x === "object" && (String(x["@context"] || "").includes("schema.org")));
  if (!structuredOk) {
    findings.push(mk("low", "structured_data_missing", "No valid JSON-LD block with @context \"schema.org\" found."));
  }

  const vague = collectVagueAnchors(html);
  if (vague.length > 0) {
    findings.push(mk("low", "vague_anchor_text", `${vague.length} anchor(s) use vague text (e.g. "click here"). Descriptive anchor text improves both SEO and a11y.`));
  }

  const counts = countBySeverity(findings);
  return {
    ok: counts.high === 0 && counts.critical === 0,
    findings,
    counts,
    stats: {
      title_length: title ? title.length : 0,
      description_length: desc ? desc.length : 0,
      h1_count: h1s.length,
      ldjson_blocks: ldjson.length,
      og_tags: countOg(metas),
      canonical: Boolean(canonical),
      lang: langMatch ? langMatch[1] : null,
    },
    meta: {
      title,
      description: desc || null,
      canonical: canonical ? canonical.href : null,
    },
  };
}

function parseMetas(html) {
  const out = [];
  let m;
  META_ATTR.lastIndex = 0;
  while ((m = META_ATTR.exec(html)) !== null) {
    out.push(parseAttrs(m[1]));
  }
  return out;
}

function parseLinks(html) {
  const out = [];
  let m;
  LINK_ATTR.lastIndex = 0;
  while ((m = LINK_ATTR.exec(html)) !== null) {
    out.push(parseAttrs(m[1]));
  }
  return out;
}

function parseAttrs(raw) {
  const out = {};
  const re = /(\w[\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const key = m[1].toLowerCase().replace(/-/g, "");
    const val = m[2] ?? m[3] ?? m[4] ?? "";
    out[key === "http-equiv" ? "httpEquiv" : key] = val;
  }
  return out;
}

function metaContent(metas, { name, property } = {}) {
  const m = metas.find(x => {
    if (name && (x.name || "").toLowerCase() === name.toLowerCase()) return true;
    if (property && (x.property || "").toLowerCase() === property.toLowerCase()) return true;
    return false;
  });
  return m && typeof m.content === "string" ? m.content.trim() : null;
}

function extractLdJson(html) {
  const out = [];
  let m;
  SCRIPT_LDJSON.lastIndex = 0;
  while ((m = SCRIPT_LDJSON.exec(html)) !== null) {
    const raw = m[1].trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      out.push(parsed);
    } catch (_e) {
      out.push({ __parse_error: true });
    }
  }
  return out;
}

function collectVagueAnchors(html) {
  const out = [];
  let m;
  ANCHOR_TAG.lastIndex = 0;
  while ((m = ANCHOR_TAG.exec(html)) !== null) {
    const text = stripTags(m[1]).trim().toLowerCase();
    if (VAGUE_ANCHORS.has(text)) out.push(text);
  }
  return out;
}

function stripTags(s) {
  return String(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

function countOg(metas) {
  return metas.filter(m => (m.property || "").toLowerCase().startsWith("og:")).length;
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
    meta: {},
  };
}

module.exports = {
  validateSeo,
};
