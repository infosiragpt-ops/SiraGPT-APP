/**
 * read_url — fetch a URL and return its main readable content as markdown.
 *
 * Pure Node stack, no external services:
 *   - `undici.request` for the fetch (Node 18+ native HTTP client)
 *   - `jsdom` for DOM construction
 *   - `@mozilla/readability` for the article extraction (the same
 *     algorithm Firefox Reader View uses)
 *   - `turndown` for HTML → markdown
 *
 * Constraints (per task #58):
 *   - Hard 8s wall-clock timeout for the entire fetch
 *   - 1 MB cap on raw HTML (response bodies larger are truncated)
 *   - 50 000 char cap on the returned markdown
 *   - Identifiable user-agent ("SiraGPTBot/1.0 (+https://siragpt.com)")
 *   - Basic robots.txt check (User-agent: * / SiraGPTBot disallow rules)
 *   - Do NOT follow cross-domain redirects
 *   - jsdom is closed after each extraction to release memory
 *
 * The handler returns a structured object and NEVER throws — failures
 * are surfaced as { error, error_code } so the agent loop can read the
 * observation and course-correct on the next turn (the same convention
 * web_search uses).
 */

const { request } = require('undici');
const dns = require('node:dns');
const net = require('node:net');
const { JSDOM } = require('jsdom');
const { Readability, isProbablyReaderable } = require('@mozilla/readability');
const TurndownService = require('turndown');

const dnsLookup = require('node:util').promisify(dns.lookup);

const USER_AGENT = 'SiraGPTBot/1.0 (+https://siragpt.com)';
const HARD_TIMEOUT_MS = 8000;
const HTML_BYTE_CAP = 1 * 1024 * 1024; // 1 MB
const DEFAULT_MAX_CHARS = 12000;
const HARD_MAX_CHARS = 50000;
const ROBOTS_CACHE_MAX = 200;
const ROBOTS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 min

// Module-level robots.txt cache. A single chat turn often calls read_url
// on several URLs from the same domain; refetching robots.txt every time
// would double the network load and defeats the point of having a budget.
const robotsCache = new Map(); // origin → { ts, rules }

function normalizeUrl(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  let u;
  try { u = new URL(trimmed); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return u;
}

/**
 * Parse a dotted-quad IPv4 string into its 32-bit numeric form, or
 * return null. We avoid the deprecated `os.networkInterfaces`-style
 * helpers and just compute the integer manually so the SSRF check has
 * no extra dependencies.
 */
function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n * 256) + v;
  }
  return n;
}

function inIpv4Cidr(ipInt, base, prefix) {
  const mask = prefix === 0 ? 0 : (~((1 << (32 - prefix)) - 1)) >>> 0;
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return false;
  return ((ipInt & mask) >>> 0) === ((baseInt & mask) >>> 0);
}

/**
 * Decide whether a resolved IP address is unsafe to fetch from a
 * server-side request. Blocks the standard private + reserved ranges
 * for both IPv4 and IPv6 (loopback, link-local, private, multicast,
 * unspecified, cloud-metadata, IPv4-mapped IPv6 of any of the above).
 *
 * Used by the SSRF guard right after DNS resolution AND on every
 * redirect hop — without the redirect check, a public host could 302
 * us to http://169.254.169.254/ and leak EC2 instance metadata.
 */
function isPrivateOrReservedIp(ip) {
  if (!ip || typeof ip !== 'string') return true; // fail closed
  // IPv4 (or IPv4-mapped IPv6 like ::ffff:10.0.0.1)
  let v4 = ip;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) v4 = mapped[1];
  if (net.isIPv4(v4)) {
    const n = ipv4ToInt(v4);
    if (n === null) return true;
    // 0.0.0.0/8 (unspecified / "this network")
    if (inIpv4Cidr(n, '0.0.0.0', 8)) return true;
    // 10.0.0.0/8 private
    if (inIpv4Cidr(n, '10.0.0.0', 8)) return true;
    // 127.0.0.0/8 loopback
    if (inIpv4Cidr(n, '127.0.0.0', 8)) return true;
    // 169.254.0.0/16 link-local (covers AWS/GCP metadata 169.254.169.254)
    if (inIpv4Cidr(n, '169.254.0.0', 16)) return true;
    // 172.16.0.0/12 private
    if (inIpv4Cidr(n, '172.16.0.0', 12)) return true;
    // 192.0.0.0/24 IETF protocol assignments
    if (inIpv4Cidr(n, '192.0.0.0', 24)) return true;
    // 192.168.0.0/16 private
    if (inIpv4Cidr(n, '192.168.0.0', 16)) return true;
    // 224.0.0.0/4 multicast
    if (inIpv4Cidr(n, '224.0.0.0', 4)) return true;
    // 240.0.0.0/4 reserved future use (includes 255.255.255.255 broadcast)
    if (inIpv4Cidr(n, '240.0.0.0', 4)) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    // fc00::/7 unique local
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;
    // fe80::/10 link-local
    if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;
    // ff00::/8 multicast
    if (/^ff[0-9a-f]{2}:/.test(lower)) return true;
    return false;
  }
  // Unknown family — be conservative.
  return true;
}

/**
 * Resolve a hostname to its A/AAAA records and reject if ANY of them
 * is private/reserved. We check ALL records (not just the first) so a
 * "DNS rebinding"-style attack that points the first record at a public
 * IP and the second at 127.0.0.1 still gets blocked.
 *
 * Honored env override: when SIRA_READ_URL_ALLOW_PRIVATE=1 we skip the
 * check entirely. This is ONLY for the test suite, which exercises the
 * skill against a loopback HTTP server.
 */
async function assertHostIsPublic(hostname) {
  if (process.env.SIRA_READ_URL_ALLOW_PRIVATE === '1') return null;
  // Literal IP in URL → skip DNS, check directly.
  if (net.isIP(hostname)) {
    return isPrivateOrReservedIp(hostname) ? hostname : null;
  }
  // Block obvious localhost-y hostnames before we even resolve, so that
  // a misconfigured resolver returning a stale public IP for "localhost"
  // (rare but real on some corporate networks) still gets caught.
  const lc = hostname.toLowerCase();
  if (lc === 'localhost' || lc.endsWith('.localhost') || lc.endsWith('.internal') || lc.endsWith('.local')) {
    return hostname;
  }
  let addrs;
  try {
    addrs = await dnsLookup(hostname, { all: true, verbatim: true });
  } catch {
    // DNS failure → can't verify safety → fail closed. The model can
    // try a different URL; that's better than leaking internals.
    return hostname;
  }
  for (const a of (addrs || [])) {
    if (isPrivateOrReservedIp(a.address)) return a.address;
  }
  return null;
}

/**
 * Tiny, deliberate robots.txt parser. We only honor `User-agent: *` and
 * `User-agent: SiraGPTBot` groups, and only the `Disallow:` directive.
 * `Allow:` is intentionally ignored — without it we just err on the side
 * of NOT fetching, which is the polite default for a key-less crawler.
 */
function parseRobots(text) {
  const rules = [];
  if (typeof text !== 'string') return rules;
  const lines = text.split(/\r?\n/);
  let activeGroup = null;
  for (let raw of lines) {
    const hashIdx = raw.indexOf('#');
    if (hashIdx >= 0) raw = raw.slice(0, hashIdx);
    const line = raw.trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const directive = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (directive === 'user-agent') {
      const v = value.toLowerCase();
      activeGroup = (v === '*' || v === 'siragptbot') ? v : null;
    } else if (directive === 'disallow' && activeGroup) {
      // RFC 9309 §2.2.2: an EMPTY `Disallow:` value means "allow all"
      // for that user-agent group. Preserve the empty string verbatim
      // — pathDisallowed treats path === '' as a no-op.
      rules.push({ agent: activeGroup, path: value });
    }
  }
  return rules;
}

function pathDisallowed(rules, urlPath) {
  if (!rules.length) return false;
  // SiraGPTBot-specific rules take precedence over `*`. If we have any
  // SiraGPTBot block we only consult those, otherwise we fall back to `*`.
  const hasSpecific = rules.some(r => r.agent === 'siragptbot');
  const applicable = rules.filter(r => r.agent === (hasSpecific ? 'siragptbot' : '*'));
  for (const r of applicable) {
    if (r.path === '') continue; // empty Disallow allows everything for that group
    if (urlPath.startsWith(r.path)) return true;
  }
  return false;
}

async function fetchRobots(origin, signal) {
  const cached = robotsCache.get(origin);
  if (cached && (Date.now() - cached.ts) < ROBOTS_CACHE_TTL_MS) return cached.rules;
  let rules = [];
  try {
    const { statusCode, body } = await request(`${origin}/robots.txt`, {
      method: 'GET',
      headers: { 'user-agent': USER_AGENT, accept: 'text/plain,*/*;q=0.5' },
      signal,
      bodyTimeout: 4000,
      headersTimeout: 4000,
    });
    if (statusCode >= 200 && statusCode < 300) {
      const text = await body.text();
      rules = parseRobots(text.slice(0, 256 * 1024)); // cap robots.txt at 256 KB
    } else {
      // Per RFC 9309: any 4xx (except 429) means "no robots, allow all".
      // 5xx / network errors → conservatively allow but don't cache long.
      await body.dump(); // drain so the connection can be reused
    }
  } catch {
    // Network failure on robots.txt is non-fatal — we proceed as if there
    // were no rules. The hard URL timeout still bounds the overall call.
  }
  // Simple FIFO eviction so the cache can't grow unbounded across
  // long-running processes.
  if (robotsCache.size >= ROBOTS_CACHE_MAX) {
    const oldest = robotsCache.keys().next().value;
    if (oldest) robotsCache.delete(oldest);
  }
  robotsCache.set(origin, { ts: Date.now(), rules });
  return rules;
}

/**
 * Read the response stream up to HTML_BYTE_CAP bytes. We truncate
 * silently rather than failing — a 2 MB article still produces a useful
 * extract from its first MB, and refusing it would force the agent to
 * give up on the source entirely.
 */
async function readBodyCapped(stream) {
  const chunks = [];
  let total = 0;
  let truncated = false;
  for await (const chunk of stream) {
    if (total + chunk.length > HTML_BYTE_CAP) {
      const remaining = HTML_BYTE_CAP - total;
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      truncated = true;
      total = HTML_BYTE_CAP;
      break;
    }
    chunks.push(chunk);
    total += chunk.length;
  }
  return { buf: Buffer.concat(chunks, total), truncated };
}

function decodeBody(buf, contentType) {
  // Best-effort charset detection from Content-Type — falls back to UTF-8.
  // We could read <meta charset> but that requires parsing the body twice;
  // 95%+ of modern pages are UTF-8 and the model is robust to the
  // occasional mis-decoded character.
  const m = /charset=["']?([\w-]+)/i.exec(contentType || '');
  const charset = (m && m[1]) ? m[1].toLowerCase() : 'utf-8';
  try {
    return buf.toString(charset === 'utf8' ? 'utf-8' : charset);
  } catch {
    return buf.toString('utf-8');
  }
}

async function execute(args = {}, _ctx = {}) {
  const url = normalizeUrl(args.url);
  if (!url) {
    return { error: 'invalid_url', message: 'url must be an absolute http(s) URL' };
  }
  const maxChars = Math.min(
    Math.max(500, Number(args.maxChars) || DEFAULT_MAX_CHARS),
    HARD_MAX_CHARS,
  );

  // Single AbortController + setTimeout enforces the hard wall clock for
  // ALL of: robots.txt fetch, main fetch, body read. jsdom parsing is
  // synchronous and bounded by the byte cap, so it doesn't need the
  // signal.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('read_url: hard timeout')), HARD_TIMEOUT_MS);
  const origin = `${url.protocol}//${url.host}`;
  const startedAt = Date.now();

  let dom = null;
  try {
    // ── SSRF guard ────────────────────────────────────────────────────
    // Resolve the hostname and reject if ANY A/AAAA record points at a
    // private / reserved / loopback / link-local address. This blocks
    // the model from coaxing read_url into hitting localhost,
    // RFC1918 internal services, or cloud metadata endpoints (e.g.
    // 169.254.169.254). Re-checked on every redirect hop below.
    const blockedHost = await assertHostIsPublic(url.hostname);
    if (blockedHost) {
      return {
        error: 'host_blocked',
        message: `Refusing to fetch private/reserved host (${blockedHost})`,
        source_url: url.toString(),
      };
    }

    // ── robots.txt ────────────────────────────────────────────────────
    const rules = await fetchRobots(origin, controller.signal);
    if (pathDisallowed(rules, url.pathname || '/')) {
      return {
        error: 'robots_disallowed',
        message: `robots.txt disallows ${url.pathname} for SiraGPTBot`,
        source_url: url.toString(),
      };
    }

    // ── Main fetch ────────────────────────────────────────────────────
    // We disable automatic redirects (maxRedirections: 0) and walk them
    // manually so we can reject cross-domain hops — the spec is explicit:
    // "no sigue redirects fuera del dominio inicial".
    let currentUrl = url;
    let response = null;
    for (let hop = 0; hop < 4; hop++) {
      response = await request(currentUrl.toString(), {
        method: 'GET',
        headers: {
          'user-agent': USER_AGENT,
          'accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
          'accept-language': 'es,en;q=0.7',
        },
        signal: controller.signal,
        bodyTimeout: HARD_TIMEOUT_MS,
        headersTimeout: HARD_TIMEOUT_MS,
      });
      if (response.statusCode >= 300 && response.statusCode < 400) {
        const loc = response.headers.location;
        if (!loc) {
          await response.body.dump();
          return { error: 'redirect_without_location', source_url: currentUrl.toString() };
        }
        let next;
        try { next = new URL(Array.isArray(loc) ? loc[0] : loc, currentUrl); } catch {
          await response.body.dump();
          return { error: 'redirect_invalid_location', source_url: currentUrl.toString() };
        }
        // Cross-domain guard — compare hostname (not host) so a port
        // change on the same hostname is allowed.
        if (next.hostname !== url.hostname) {
          await response.body.dump();
          return {
            error: 'cross_domain_redirect_blocked',
            from: currentUrl.hostname,
            to: next.hostname,
            source_url: currentUrl.toString(),
          };
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          await response.body.dump();
          return { error: 'unsafe_redirect_scheme', source_url: currentUrl.toString() };
        }
        // Re-run the SSRF guard for the redirect target — a public host
        // could otherwise 302 us into localhost / metadata IPs.
        const redirectBlocked = await assertHostIsPublic(next.hostname);
        if (redirectBlocked) {
          await response.body.dump();
          return {
            error: 'host_blocked',
            message: `Refusing redirect to private/reserved host (${redirectBlocked})`,
            source_url: currentUrl.toString(),
          };
        }
        await response.body.dump();
        currentUrl = next;
        continue;
      }
      break;
    }
    if (!response) {
      return { error: 'no_response', source_url: url.toString() };
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      await response.body.dump().catch(() => {});
      return {
        error: 'http_error',
        status: response.statusCode,
        source_url: currentUrl.toString(),
      };
    }
    const contentType = String(response.headers['content-type'] || '');
    if (contentType && !/html|xml|text\/plain/i.test(contentType)) {
      await response.body.dump().catch(() => {});
      return {
        error: 'unsupported_content_type',
        content_type: contentType,
        source_url: currentUrl.toString(),
      };
    }

    const { buf, truncated } = await readBodyCapped(response.body);
    const html = decodeBody(buf, contentType);
    if (!html || html.length < 50) {
      return { error: 'empty_body', source_url: currentUrl.toString() };
    }

    // ── Extraction ────────────────────────────────────────────────────
    // JSDOM with no script execution (we never want to run remote JS).
    // url is passed so Readability resolves relative links sensibly.
    dom = new JSDOM(html, {
      url: currentUrl.toString(),
      contentType: 'text/html',
      runScripts: 'outside-only',
      pretendToBeVisual: false,
    });
    const doc = dom.window.document;

    // isProbablyReaderable is a cheap heuristic — if it says no, we skip
    // Readability and fall back to a body-text strip. This avoids hangs
    // on Single-Page Apps where there's only a `<div id="root"/>`.
    let article = null;
    if (isProbablyReaderable(doc)) {
      try {
        article = new Readability(doc.cloneNode(true), {
          charThreshold: 200,
          keepClasses: false,
        }).parse();
      } catch {
        article = null;
      }
    }

    // Markdown conversion: prefer Readability's `content` HTML; fall
    // back to <body> text content stripped to plain prose if Readability
    // couldn't find an article.
    const turndown = new TurndownService({
      headingStyle: 'atx',
      bulletListMarker: '-',
      codeBlockStyle: 'fenced',
      emDelimiter: '_',
    });
    turndown.remove(['script', 'style', 'iframe', 'noscript', 'svg', 'video', 'audio']);
    let markdown = '';
    let titleOut = '';
    let byline = '';
    if (article && article.content) {
      markdown = turndown.turndown(article.content || '');
      titleOut = article.title || doc.title || '';
      byline = article.byline || '';
    } else {
      const body = doc.body ? doc.body.innerHTML : '';
      markdown = turndown.turndown(body);
      titleOut = doc.title || '';
    }

    // Collapse runs of blank lines to keep the markdown compact (helps
    // the downstream LLM stay under its tool-message char cap).
    markdown = markdown.replace(/\n{3,}/g, '\n\n').trim();

    const originalLength = markdown.length;
    let capApplied = false;
    if (markdown.length > maxChars) {
      markdown = markdown.slice(0, maxChars) + '\n\n[…contenido recortado al límite de caracteres…]';
      capApplied = true;
    }

    return {
      title: (titleOut || '').slice(0, 300),
      byline: byline ? String(byline).slice(0, 200) : '',
      content_markdown: markdown,
      length: markdown.length,
      original_length: originalLength,
      source_url: currentUrl.toString(),
      truncated_html: truncated,
      truncated_markdown: capApplied,
      readability: Boolean(article),
      fetched_in_ms: Date.now() - startedAt,
    };
  } catch (err) {
    const isAbort = err && (err.name === 'AbortError' || /abort|timeout/i.test(err.message || ''));
    return {
      error: isAbort ? 'timeout' : 'fetch_failed',
      message: String(err && err.message || err).slice(0, 300),
      source_url: url.toString(),
      fetched_in_ms: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
    // Free the heavy DOM tree explicitly — jsdom holds a lot of cyclic
    // refs that V8's GC won't reclaim for several minutes otherwise.
    if (dom) {
      try { dom.window.close(); } catch { /* dom already torn down */ }
    }
  }
}

module.exports = {
  execute,
  _internal: {
    parseRobots,
    pathDisallowed,
    normalizeUrl,
    isPrivateOrReservedIp,
    assertHostIsPublic,
  },
};
