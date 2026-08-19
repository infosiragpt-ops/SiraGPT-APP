'use strict';

/**
 * web-fetch — outbound HTTP fetch primitive exposed as the
 * `web.fetch` MCP tool. The tool is disabled by default; an operator
 * opts in via env vars and explicitly lists which hosts are
 * reachable.
 *
 * Security posture (load-bearing — do not weaken without review):
 *
 *   1. DISABLED by default. `MCP_WEB_FETCH_ENABLED` must be set
 *      truthy AND `MCP_WEB_FETCH_ALLOWED_HOSTS` must contain at
 *      least one entry. A bare "enabled but no allowlist" config
 *      is treated as disabled (fail-closed).
 *
 *   2. Scheme allowlist: http and https ONLY. file://, gopher://,
 *      ftp://, dict://, etc. are all rejected. The `url.protocol`
 *      check catches every non-http(s) URL before we look at the
 *      host.
 *
 *   3. IP literal in URL is REJECTED. Without this, an attacker
 *      could bypass the host allowlist by issuing a request to
 *      `https://203.0.113.5/` even though only `example.com` was
 *      allowed. The MCP tool is intended for known DNS hostnames,
 *      not raw IPs.
 *
 *   4. Private / loopback / link-local / cloud-metadata addresses
 *      are blocked even if they somehow show up after DNS
 *      resolution. The check runs against the URL hostname AND
 *      against a fresh DNS lookup of the host, so an attacker
 *      cannot register a public DNS A record pointing at
 *      169.254.169.254 (AWS / GCP metadata) and have us follow it.
 *      This is the canonical SSRF defense.
 *
 *   5. Host allowlist check is exact-suffix: `example.com` matches
 *      `example.com` and `api.example.com`, but does not match
 *      `notexample.com` or `example.com.attacker.tld`.
 *
 *   6. Response size is capped (default 1 MB) and the bytes beyond
 *      the cap are dropped — never buffered, never returned.
 *
 *   7. Timeout via AbortController (default 10 s). A hung server
 *      cannot stall the agent loop.
 *
 *   8. Redirects: tracked by undici (Node fetch). If the final
 *      destination is a blocked host, the response is rejected
 *      AFTER the redirect chain — we re-validate the final URL.
 *
 * Tests live in backend/tests/web-fetch.test.js and pin every
 * branch above.
 */

const dns = require('node:dns').promises;
const net = require('node:net');

const DEFAULT_MAX_BYTES = 1024 * 1024; // 1 MB
const DEFAULT_TIMEOUT_MS = 10_000;
const HARD_MAX_BYTES = 2 * 1024 * 1024;
const HARD_MAX_TIMEOUT_MS = 30_000;

class WebFetchError extends Error {
  constructor(code, status, message, details = {}) {
    super(message);
    this.name = 'WebFetchError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function resolveAllowedHosts(env = process.env) {
  const raw = String(env.MCP_WEB_FETCH_ALLOWED_HOSTS || '').trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

function resolveWebFetchConfig(env = process.env) {
  const enabledFlag = parseBoolean(env.MCP_WEB_FETCH_ENABLED, false);
  const allowedHosts = resolveAllowedHosts(env);
  const enabled = enabledFlag && allowedHosts.length > 0;
  return {
    enabled,
    enabledFlag,
    allowedHosts,
    defaultMaxBytes: clampInt(env.MCP_WEB_FETCH_MAX_BYTES, DEFAULT_MAX_BYTES, 1024, HARD_MAX_BYTES),
    defaultTimeoutMs: clampInt(env.MCP_WEB_FETCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1000, HARD_MAX_TIMEOUT_MS),
  };
}

function clampInt(raw, fallback, min, max) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function isPrivateOrReservedAddress(addr) {
  if (typeof addr !== 'string' || !addr) return true; // fail-closed
  const family = net.isIP(addr);
  if (family === 0) return false; // not an IP literal
  if (family === 4) {
    const parts = addr.split('.').map((n) => Number.parseInt(n, 10));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return true;
    const [a, b] = parts;
    if (a === 10) return true;                      // 10.0.0.0/8
    if (a === 127) return true;                     // loopback
    if (a === 0) return true;                       // 0.0.0.0/8
    if (a === 169 && b === 254) return true;        // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true;        // 192.168.0.0/16
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a === 224) return true;                     // multicast
    if (a >= 240) return true;                      // reserved
    return false;
  }
  // IPv6
  const lower = addr.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80:')) return true;       // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA
  if (lower.startsWith('ff')) return true;          // multicast
  return false;
}

function hostMatchesAllowlist(host, allowlist) {
  const target = String(host || '').toLowerCase();
  if (!target) return false;
  return allowlist.some((entry) => target === entry || target.endsWith(`.${entry}`));
}

/**
 * validateRequestUrl — pure, synchronous URL safety check.
 * Throws WebFetchError on rejection. Used both pre-fetch and
 * post-redirect to validate the final URL.
 */
function validateRequestUrl(rawUrl, allowlist) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_err) {
    throw new WebFetchError('web_fetch_invalid_url', 400, 'url is not a parseable absolute URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new WebFetchError('web_fetch_unsupported_scheme', 400, 'only http and https are supported', {
      scheme: parsed.protocol,
    });
  }
  if (!parsed.hostname) {
    throw new WebFetchError('web_fetch_no_host', 400, 'url has no host component');
  }
  // Strip IPv6 brackets that URL parser keeps (`[::1]` → `::1`).
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    throw new WebFetchError('web_fetch_ip_literal_rejected', 400, 'IP literals are not allowed; use a hostname', {
      host,
    });
  }
  if (isPrivateOrReservedAddress(host)) {
    // Defensive: net.isIP returned 0, but the function still catches
    // edge cases like literal "localhost" in some pre-checks. The
    // check below is the one that catches that string.
    throw new WebFetchError('web_fetch_blocked_host', 400, 'host is not reachable from this tool', { host });
  }
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new WebFetchError('web_fetch_blocked_host', 400, 'localhost is not reachable from this tool');
  }
  if (!hostMatchesAllowlist(host, allowlist)) {
    throw new WebFetchError('web_fetch_host_not_allowlisted', 403, 'host is not in MCP_WEB_FETCH_ALLOWED_HOSTS', {
      host,
    });
  }
  return parsed;
}

/**
 * resolveAndAssertSafe — performs DNS resolution and verifies the
 * resolved IPs are not private/loopback/link-local. This is the
 * second SSRF defense layer; even if a hostname is on the allowlist,
 * we refuse to reach it if its A/AAAA records point at a metadata
 * endpoint (e.g. registered DNS rebinding).
 */
async function resolveAndAssertSafe(host, lookup = dns.lookup) {
  let records;
  try {
    records = await lookup(host, { all: true });
  } catch (err) {
    throw new WebFetchError('web_fetch_dns_failed', 502, 'DNS resolution failed', {
      host,
      cause: err && err.code,
    });
  }
  if (!Array.isArray(records) || records.length === 0) {
    throw new WebFetchError('web_fetch_dns_empty', 502, 'DNS returned no addresses', { host });
  }
  for (const record of records) {
    if (isPrivateOrReservedAddress(record.address)) {
      throw new WebFetchError(
        'web_fetch_resolved_blocked',
        400,
        'hostname resolved to a private / loopback / metadata address',
        { host, address: record.address },
      );
    }
  }
}

/**
 * executeWebFetch — main entry point. Validates, resolves, fetches,
 * caps response size, returns the structured result. The MCP tool
 * registry wraps this in textResult().
 */
async function executeWebFetch(args = {}, env = process.env, options = {}) {
  const config = resolveWebFetchConfig(env);
  if (!config.enabled) {
    throw new WebFetchError('web_fetch_disabled', 403, 'web.fetch is disabled on this deployment', {
      hint: 'set MCP_WEB_FETCH_ENABLED=true and MCP_WEB_FETCH_ALLOWED_HOSTS to a non-empty list',
    });
  }

  const url = String(args.url || '').trim();
  if (!url) {
    throw new WebFetchError('web_fetch_invalid_arguments', 400, 'url argument is required');
  }
  const parsed = validateRequestUrl(url, config.allowedHosts);

  // DNS safety check (second SSRF defense layer). Skippable in tests
  // via options.skipDnsCheck so we don't have to resolve real hosts.
  if (!options.skipDnsCheck) {
    await resolveAndAssertSafe(parsed.hostname, options.lookup);
  }

  const maxBytes = clampInt(args.maxBytes, config.defaultMaxBytes, 1024, HARD_MAX_BYTES);
  const timeoutMs = clampInt(args.timeoutMs, config.defaultTimeoutMs, 1000, HARD_MAX_TIMEOUT_MS);

  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new WebFetchError('web_fetch_runtime_missing', 500, 'no fetch implementation available');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetchImpl(parsed.toString(), {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'siraGPT-mcp-web-fetch/1.0' },
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') {
      throw new WebFetchError('web_fetch_timeout', 504, 'fetch exceeded timeout', { timeoutMs });
    }
    throw new WebFetchError('web_fetch_network_error', 502, 'network error', { detail: err && err.message });
  }
  clearTimeout(timer);

  // Re-validate the post-redirect URL: if a redirect chain hopped to
  // a non-allowlisted host, refuse the response. We do NOT re-do
  // DNS here — fetch already resolved during the redirect — but the
  // host check is still meaningful.
  const finalUrl = response.url || parsed.toString();
  validateRequestUrl(finalUrl, config.allowedHosts);

  const contentType = String(response.headers.get('content-type') || '').toLowerCase();

  // Stream-cap the body. We don't trust Content-Length headers — a
  // malicious server can lie about it, so the cap is enforced on
  // bytes actually read.
  const reader = response.body && response.body.getReader ? response.body.getReader() : null;
  let body = '';
  let bytesRead = 0;
  let truncated = false;
  if (reader) {
    const decoder = new TextDecoder('utf-8', { fatal: false });
    while (bytesRead < maxBytes) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value;
      const remaining = maxBytes - bytesRead;
      if (chunk.byteLength > remaining) {
        body += decoder.decode(chunk.subarray(0, remaining), { stream: false });
        bytesRead += remaining;
        truncated = true;
        try { reader.cancel(); } catch (_) { /* ignore */ }
        break;
      }
      body += decoder.decode(chunk, { stream: true });
      bytesRead += chunk.byteLength;
    }
    body += decoder.decode();
  } else {
    // Older runtimes / mocks return a string body via `.text()`.
    const fullText = await response.text();
    if (fullText.length > maxBytes) {
      body = fullText.slice(0, maxBytes);
      truncated = true;
    } else {
      body = fullText;
    }
    bytesRead = body.length;
  }

  return {
    status: response.status,
    contentType,
    body,
    bytesRead,
    truncated,
    finalUrl,
  };
}

module.exports = {
  executeWebFetch,
  resolveWebFetchConfig,
  resolveAllowedHosts,
  validateRequestUrl,
  resolveAndAssertSafe,
  isPrivateOrReservedAddress,
  hostMatchesAllowlist,
  WebFetchError,
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  HARD_MAX_BYTES,
  HARD_MAX_TIMEOUT_MS,
};
