'use strict';

/**
 * web_fetch — open-world URL fetcher for the chat agent.
 *
 * Unlike the MCP-hub `web.fetch` connector (allowlist-only, disabled by
 * default — the right posture for machine-to-machine use), the chat agent
 * needs to read arbitrary PUBLIC web pages the model just discovered via
 * web_search. The security posture here is deny-by-class instead of
 * allow-by-list, reusing the hub's hardened primitives:
 *
 *   - http/https only; credentials in the URL rejected.
 *   - private / loopback / link-local / CGNAT / cloud-metadata addresses
 *     blocked BOTH as URL literals and after a fresh DNS resolution of the
 *     hostname (anti DNS-rebinding), via connectors/web-fetch.js
 *     `isPrivateOrReservedAddress` + `resolveAndAssertSafe`.
 *   - redirects followed MANUALLY (≤5 hops) and every hop re-validated with
 *     the same URL + DNS checks — a public page cannot bounce the agent into
 *     169.254.169.254 or an internal service.
 *   - response body stream-capped (2 MB read cap) and the extracted text
 *     capped at 50k chars with an explicit truncation marker.
 *
 * HTML is sanitized to readable text: Readability (main-article extraction)
 * → Turndown (markdown) with cheerio tag-stripping as the fallback chain.
 * Script/style/template content never reaches the model.
 */

const net = require('node:net');
const { z } = require('zod');
const {
  isPrivateOrReservedAddress,
  resolveAndAssertSafe,
  WebFetchError,
} = require('../../connectors/web-fetch');

const MAX_TEXT_CHARS = 50_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024; // raw read cap before extraction
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data', // EC2 IMDS alias
  'metadata.azure.com',
]);

const inputSchema = z.object({
  url: z.string().min(8).max(4_000).describe('Absolute http(s) URL to fetch'),
  maxChars: z.number().int().min(500).max(MAX_TEXT_CHARS).optional()
    .describe('Cap for the extracted text (default 50000)'),
  raw: z.boolean().optional()
    .describe('Return the raw body text instead of the readable-article extraction (only for non-HTML or debugging)'),
}).strict();

/** Throws WebFetchError when the URL is not a safe public http(s) target. */
function assertSafeUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch (_) {
    throw new WebFetchError('web_fetch_invalid_url', 400, 'url is not a parseable absolute URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new WebFetchError('web_fetch_unsupported_scheme', 400, `only http and https are supported (got ${parsed.protocol})`);
  }
  if (parsed.username || parsed.password) {
    throw new WebFetchError('web_fetch_credentials_rejected', 400, 'URLs with embedded credentials are not allowed');
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) throw new WebFetchError('web_fetch_no_host', 400, 'url has no host component');
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new WebFetchError('web_fetch_blocked_host', 400, `host "${host}" is not reachable from this tool`);
  }
  if (net.isIP(host)) {
    // Public IP literals are allowed; private/reserved/metadata ranges never.
    if (isPrivateOrReservedAddress(host)) {
      throw new WebFetchError('web_fetch_blocked_host', 400, 'private / reserved IP addresses are not reachable from this tool');
    }
  }
  return parsed;
}

async function assertSafeTarget(parsedUrl, lookup) {
  const host = parsedUrl.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return; // literal already vetted by assertSafeUrl
  await resolveAndAssertSafe(host, lookup); // DNS layer (anti-rebinding)
}

async function readCappedBody(response, maxBytes) {
  const reader = response.body && response.body.getReader ? response.body.getReader() : null;
  if (!reader) {
    const text = await response.text();
    return { body: text.slice(0, maxBytes), truncated: text.length > maxBytes };
  }
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let body = '';
  let bytesRead = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - bytesRead;
      if (value.byteLength >= remaining) {
        body += decoder.decode(value.subarray(0, remaining), { stream: false });
        truncated = true;
        break;
      }
      body += decoder.decode(value, { stream: true });
      bytesRead += value.byteLength;
    }
    if (!truncated) body += decoder.decode();
  } finally {
    // Release the stream on every exit path (done, truncation, mid-read
    // throw) — previously only truncation cancelled, leaking the socket.
    try { reader.cancel(); } catch (_) { /* ignore */ }
  }
  return { body, truncated };
}

/** HTML → readable text. Readability → Turndown, cheerio strip fallback. */
function htmlToReadableText(html, baseUrl) {
  try {
    const { JSDOM } = require('jsdom');
    const { Readability } = require('@mozilla/readability');
    const dom = new JSDOM(html, { url: baseUrl });
    const article = new Readability(dom.window.document).parse();
    if (article && article.content) {
      const TurndownService = require('turndown');
      const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
      const markdown = turndown.turndown(article.content);
      const text = markdown.replace(/\n{3,}/g, '\n\n').trim();
      if (text) return { title: article.title || null, text };
    }
  } catch (_) { /* fall through to the tag-strip chain */ }
  try {
    const cheerio = require('cheerio');
    const $ = cheerio.load(html);
    $('script, style, noscript, template, svg, iframe').remove();
    const title = ($('title').first().text() || '').trim() || null;
    const text = $('body').text().replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return { title, text };
  } catch (_) {
    return { title: null, text: String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() };
  }
}

function capText(text, maxChars) {
  const str = String(text || '');
  if (str.length <= maxChars) return { text: str, truncated: false };
  const marker = `\n\n[...contenido truncado: se muestran ${maxChars} de ${str.length} caracteres]`;
  return { text: str.slice(0, maxChars - marker.length) + marker, truncated: true };
}

/**
 * Core fetch with manual, re-validated redirects.
 * @param {object} args        — validated tool args.
 * @param {object} [options]   — { fetch, lookup, timeoutMs } injectables for tests.
 */
async function executeAgentWebFetch(args, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const maxChars = args.maxChars || MAX_TEXT_CHARS;

  let current = assertSafeUrl(args.url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await assertSafeTarget(current, options.lookup);
      let res;
      try {
        res = await fetchImpl(current.toString(), {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            'user-agent': 'siraGPT-agent-web-fetch/1.0 (+https://siragpt.com)',
            accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5',
          },
        });
      } catch (err) {
        if (err && err.name === 'AbortError') {
          throw new WebFetchError('web_fetch_timeout', 504, `fetch exceeded ${timeoutMs}ms timeout`);
        }
        throw new WebFetchError('web_fetch_network_error', 502, `network error: ${err && err.message}`);
      }
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) throw new WebFetchError('web_fetch_bad_redirect', 502, `redirect (${res.status}) without Location header`);
        if (hop === MAX_REDIRECTS) throw new WebFetchError('web_fetch_too_many_redirects', 502, `more than ${MAX_REDIRECTS} redirects`);
        current = assertSafeUrl(new URL(location, current).toString());
        try { if (res.body && res.body.cancel) await res.body.cancel(); } catch (_) { /* ignore */ }
        continue;
      }
      response = res;
      break;
    }

    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    const isTexty = /text\/|application\/(json|xml|xhtml|javascript|rss|atom)|\+json|\+xml/.test(contentType) || contentType === '';
    if (!isTexty) {
      // Cancel the unread body before returning — leaving it unconsumed leaks the
      // underlying socket/stream (mirrors the redirect path's cancel above).
      try { if (response.body && response.body.cancel) await response.body.cancel(); } catch (_) { /* ignore */ }
      return {
        url: args.url,
        finalUrl: current.toString(),
        status: response.status,
        contentType,
        text: '',
        truncated: false,
        note: `El contenido es binario (${contentType}); web_fetch solo extrae texto. Usa otra herramienta si necesitas el archivo.`,
      };
    }

    const { body, truncated: bodyTruncated } = await readCappedBody(response, MAX_BODY_BYTES);
    const looksHtml = /html/.test(contentType) || /^\s*<!doctype html|^\s*<html/i.test(body);
    let title = null;
    let text = body;
    if (looksHtml && !args.raw) {
      const extracted = htmlToReadableText(body, current.toString());
      title = extracted.title;
      text = extracted.text;
    }
    const capped = capText(text, maxChars);
    return {
      url: args.url,
      finalUrl: current.toString(),
      status: response.status,
      contentType,
      ...(title ? { title } : {}),
      text: capped.text,
      truncated: capped.truncated || bodyTruncated,
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildWebFetchTool(options = {}) {
  return {
    name: 'web_fetch',
    description: [
      'Fetch a PUBLIC web page or API URL and return its readable text content (HTML is sanitized to markdown-like text, capped at 50k chars).',
      'WHEN TO USE: you already have a concrete URL (from web_search results, the user, or a previous page) and need its actual content to answer.',
      'WHEN NOT TO USE: to discover pages (use web_search first); for URLs of files you must download or transform (use the document tools); for anything on localhost or private networks (blocked).',
      'Errors come back as structured messages — adapt (try another source) instead of retrying the same URL more than once.',
    ].join(' '),
    inputSchema,
    permissionTier: 'auto',
    humanDescription: (args = {}) => {
      try { return `Leyendo ${new URL(String(args.url)).hostname.replace(/^www\./, '')}`; }
      catch (_) { return 'Leyendo una página web'; }
    },
    execute: async (args) => executeAgentWebFetch(args, options),
  };
}

module.exports = {
  buildWebFetchTool,
  executeAgentWebFetch,
  assertSafeUrl,
  htmlToReadableText,
  capText,
  MAX_TEXT_CHARS,
  MAX_REDIRECTS,
};
