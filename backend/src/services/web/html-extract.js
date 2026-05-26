/**
 * html-extract — pull structured data from raw HTML without pulling
 * in a browser or a full DOM library.
 *
 * Extractors (each returns a plain-JS shape):
 *   - extractJsonLd(html)     → array of parsed <script type="application/ld+json">
 *   - extractOpenGraph(html)  → { title, description, image, type, url, site_name, ... }
 *   - extractTwitterCards(html) → { card, title, description, image, site, creator }
 *   - extractMeta(html)       → { title, description, canonical, lang, charset, viewport, robots, keywords }
 *   - extractBreadcrumbs(html)→ list parsed from JSON-LD BreadcrumbList
 *
 * Pure regex over the HTML text. Good enough for structured-data
 * scraping where the site has already been fetched; NOT a
 * replacement for cheerio when you need actual DOM traversal.
 */

function decodeEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function findAttr(tag, attr) {
  // Match attr="value" | attr='value' | attr=value
  const rxDouble = new RegExp(`\\b${attr}\\s*=\\s*"([^"]*)"`, "i");
  const rxSingle = new RegExp(`\\b${attr}\\s*=\\s*'([^']*)'`, "i");
  const rxBare = new RegExp(`\\b${attr}\\s*=\\s*([^\\s>]+)`, "i");
  const m = tag.match(rxDouble) || tag.match(rxSingle) || tag.match(rxBare);
  return m ? decodeEntities(m[1]) : null;
}

function extractJsonLd(html) {
  if (typeof html !== "string" || !html) return [];
  const out = [];
  const rx = /<script\b[^>]*type=["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = rx.exec(html)) !== null) {
    const raw = m[1].trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) out.push(...parsed);
      else out.push(parsed);
    } catch {
      // Some sites inline an array without the outer brackets. Try recovery.
      try {
        const recovered = JSON.parse(`[${raw}]`);
        if (Array.isArray(recovered)) out.push(...recovered);
      } catch { /* skip bad block */ }
    }
  }
  return out;
}

function extractMetaMap(html) {
  const map = new Map();
  if (typeof html !== "string") return map;
  const rx = /<meta\b[^>]*>/gi;
  let m;
  while ((m = rx.exec(html)) !== null) {
    const tag = m[0];
    const name = (findAttr(tag, "property") || findAttr(tag, "name") || findAttr(tag, "itemprop") || "").toLowerCase();
    const content = findAttr(tag, "content");
    if (!name || content === null) continue;
    if (!map.has(name)) map.set(name, content);
  }
  return map;
}

function extractOpenGraph(html) {
  const meta = extractMetaMap(html);
  const og = {};
  for (const [k, v] of meta.entries()) {
    if (k.startsWith("og:")) og[k.slice(3)] = v;
  }
  return og;
}

function extractTwitterCards(html) {
  const meta = extractMetaMap(html);
  const out = {};
  for (const [k, v] of meta.entries()) {
    if (k.startsWith("twitter:")) out[k.slice(8)] = v;
  }
  return out;
}

function extractTitle(html) {
  const m = String(html || "").match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1].trim()) : null;
}

function extractCanonical(html) {
  const m = String(html || "").match(/<link\b[^>]*rel=["']?canonical["']?[^>]*>/i);
  return m ? findAttr(m[0], "href") : null;
}

function extractLang(html) {
  const m = String(html || "").match(/<html\b[^>]*>/i);
  return m ? findAttr(m[0], "lang") : null;
}

function extractCharset(html) {
  const m = String(html || "").match(/<meta\b[^>]*charset\s*=\s*["']?([^"'\s>]+)["']?[^>]*>/i);
  return m ? decodeEntities(m[1]) : null;
}

function extractMeta(html) {
  const map = extractMetaMap(html);
  return {
    title: extractTitle(html),
    description: map.get("description") || null,
    canonical: extractCanonical(html),
    lang: extractLang(html),
    charset: extractCharset(html),
    viewport: map.get("viewport") || null,
    robots: map.get("robots") || null,
    keywords: map.get("keywords") || null,
  };
}

function extractBreadcrumbs(html) {
  const blocks = extractJsonLd(html);
  const out = [];
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    const candidates = Array.isArray(b) ? b : [b];
    for (const c of candidates) {
      const t = c["@type"] || c.type;
      if (t === "BreadcrumbList" && Array.isArray(c.itemListElement)) {
        for (const el of c.itemListElement) {
          if (el && typeof el === "object") {
            out.push({
              position: el.position || null,
              name: el.name || (el.item && el.item.name) || null,
              url: typeof el.item === "string" ? el.item : (el.item && el.item["@id"]) || null,
            });
          }
        }
      }
    }
  }
  return out;
}

/**
 * One-shot extractor that returns every bucket at once.
 */
function extractAll(html) {
  return {
    meta: extractMeta(html),
    openGraph: extractOpenGraph(html),
    twitter: extractTwitterCards(html),
    jsonLd: extractJsonLd(html),
    breadcrumbs: extractBreadcrumbs(html),
  };
}

module.exports = {
  extractAll,
  extractMeta,
  extractJsonLd,
  extractOpenGraph,
  extractTwitterCards,
  extractTitle,
  extractCanonical,
  extractLang,
  extractCharset,
  extractBreadcrumbs,
  decodeEntities,
};
