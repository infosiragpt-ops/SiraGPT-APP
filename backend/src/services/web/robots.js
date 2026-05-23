/**
 * robots — parse robots.txt content and decide allow/deny for a
 * (user-agent, url) pair. Implements the subset of RFC 9309
 * (Robots Exclusion Protocol) that real crawlers care about:
 *
 *   - User-agent: matching (exact, then *)
 *   - Allow / Disallow longest-prefix match (longest match wins)
 *   - Crawl-delay (seconds) per user-agent
 *   - Sitemap directives harvested out of the file
 *
 * Limitations:
 *   - No $ / * wildcard support for disallow paths (we add a toggle
 *     `extendedWildcards:true` that does a simple regex when needed).
 *   - No conditional language (robots.txt spec doesn't define one).
 *
 * Pure: no fetching, no DNS. Callers feed the robots.txt text in.
 */

function parseRobots(text) {
  const out = {
    groups: [],              // [{ agents: ["*"|"bot"], allow: [...], disallow: [...], crawlDelay?: number }]
    sitemaps: [],
  };
  let current = null;
  const lines = String(text || "").split(/\r?\n/);
  for (let raw of lines) {
    raw = raw.replace(/#.*$/, "").trim();
    if (!raw) continue;
    const idx = raw.indexOf(":");
    if (idx === -1) continue;
    const key = raw.slice(0, idx).trim().toLowerCase();
    const value = raw.slice(idx + 1).trim();
    if (!value && key !== "user-agent") continue;

    if (key === "user-agent") {
      if (!current || current._frozen) {
        current = { agents: [], allow: [], disallow: [], _frozen: false };
        out.groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (key === "allow" || key === "disallow") {
      if (!current) {
        current = { agents: ["*"], allow: [], disallow: [], _frozen: false };
        out.groups.push(current);
      }
      current._frozen = true;
      current[key].push(value);
    } else if (key === "crawl-delay") {
      if (!current) {
        current = { agents: ["*"], allow: [], disallow: [], _frozen: false };
        out.groups.push(current);
      }
      current._frozen = true;
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
    } else if (key === "sitemap") {
      out.sitemaps.push(value);
    }
  }
  for (const g of out.groups) delete g._frozen;
  return out;
}

function pickGroup(parsed, userAgent) {
  const ua = String(userAgent || "").toLowerCase();
  // Exact-match first
  for (const g of parsed.groups) {
    if (g.agents.some(a => a !== "*" && ua === a)) return g;
  }
  // Substring match on bot tokens
  for (const g of parsed.groups) {
    if (g.agents.some(a => a !== "*" && ua.includes(a))) return g;
  }
  // Wildcard fallback
  for (const g of parsed.groups) {
    if (g.agents.includes("*")) return g;
  }
  return null;
}

function pathOf(urlOrPath) {
  if (typeof urlOrPath !== "string") return "/";
  if (!urlOrPath.includes("://")) return urlOrPath;
  try {
    const u = new URL(urlOrPath);
    return u.pathname + (u.search || "");
  } catch {
    return urlOrPath;
  }
}

/**
 * Longest-match decision. When Allow and Disallow have the same
 * length, Allow wins (per Google's extension and common practice).
 */
function isAllowed(userAgent, url, robotsText, opts = {}) {
  const parsed = typeof robotsText === "string" ? parseRobots(robotsText) : robotsText;
  const group = pickGroup(parsed, userAgent);
  if (!group) return { allowed: true, reason: "no matching robots group", crawlDelay: 0 };
  const path = pathOf(url);

  const match = (rule) => {
    if (rule === "") return 0; // empty disallow means allow all
    if (opts.extendedWildcards && /[*$]/.test(rule)) {
      // Convert $ anchor and * wildcard into regex; path match
      const pat = rule
        .replace(/[.+?^=!:${}()|[\]\\]/g, "\\$&")
        .replace(/\\\*/g, ".*")
        .replace(/\\\$$/, "$");
      return new RegExp("^" + pat).test(path) ? rule.length : -1;
    }
    return path.startsWith(rule) ? rule.length : -1;
  };

  let bestAllow = -1;
  let bestDisallow = -1;
  for (const rule of group.allow || []) { const m = match(rule); if (m > bestAllow) bestAllow = m; }
  for (const rule of group.disallow || []) { const m = match(rule); if (m > bestDisallow) bestDisallow = m; }

  let allowed = true;
  let reason = "default allow";
  if (bestDisallow > bestAllow) { allowed = false; reason = `disallow rule matched (len=${bestDisallow})`; }
  else if (bestAllow > 0 && bestAllow >= bestDisallow) { allowed = true; reason = `allow rule matched (len=${bestAllow})`; }
  else if (bestDisallow === 0 && (group.disallow || []).some(r => r === "")) { allowed = true; reason = "empty disallow (explicit allow)"; }
  else if (bestDisallow > 0 && bestAllow === -1) { allowed = false; reason = `disallow rule matched (len=${bestDisallow})`; }

  return {
    allowed,
    reason,
    crawlDelay: group.crawlDelay || 0,
    matchedAgents: group.agents,
  };
}

module.exports = {
  parseRobots,
  pickGroup,
  isAllowed,
  pathOf,
};
