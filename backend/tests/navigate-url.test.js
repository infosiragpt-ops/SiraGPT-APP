'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  sanitizeNavigateUrl, looksLikeSearchQuery, classifyNavigationFailure, searchUrlFor, DEFAULT_SEARCH_URL,
} = require('../src/services/computer/navigate-url');

const route = fs.readFileSync(path.join(__dirname, '../src/routes/agent-computer.js'), 'utf8');

function throwsInvalid(raw) {
  assert.throws(() => sanitizeNavigateUrl(raw), (err) => err && err.code === 'invalid_url');
}

describe('integrated navigator URL gate', () => {
  it('is the sanitizer used by POST /agent-computer/navigate', () => {
    assert.match(route, /sanitizeNavigateUrl/);
    assert.match(route, /services\/computer\/navigate-url/);
    assert.match(route, /router\.post\('\/navigate'/);
  });

  it('accepts http(s) URLs the agent can open anywhere', () => {
    const cases = [
      ['https://siragpt.com', 'https://siragpt.com/'],
      ['http://example.com/path', 'http://example.com/path'],
      ['https://id.elsevier.com/as/authorization.oauth2?platSite=SC', 'https://id.elsevier.com/as/authorization.oauth2?platSite=SC'],
      ['scopus.com', 'https://scopus.com/'],
      ['www.google.com/search?q=sira', 'https://www.google.com/search?q=sira'],
      ['https://127.0.0.1:8080/health', 'https://127.0.0.1:8080/health'],
      ['https://xn--fsq.xn--0zwm56d/', 'https://xn--fsq.xn--0zwm56d/'],
    ];
    for (const [input, expected] of cases) {
      assert.equal(sanitizeNavigateUrl(input), expected, input);
    }
  });

  it('refuses schemes that cannot be a web navigator', () => {
    const blocked = [
      '',
      '   ',
      'javascript:alert(1)',
      'data:text/html,hi',
      'file:///etc/passwd',
      'vbscript:msg',
      'blob:https://x',
      'about:blank',
      'mailto:a@b.c',
      'ftp://files.example',
      'chrome://settings',
      'chrome-extension://abc',
      '://missing-scheme',
    ];
    for (const raw of blocked) throwsInvalid(raw);
  });

  it('accepts 1000 distinct https destinations for E2E-scale coverage', () => {
    for (let i = 0; i < 1000; i += 1) {
      const input = `https://nav-${i}.example.test/search/${i}?q=${i}#hit`;
      const out = sanitizeNavigateUrl(input);
      assert.equal(out, new URL(input).toString());
      assert.match(out, /^https:\/\//);
    }
  });
});

// Production 2026-10-07: «google» typed in the address bar became
// `https://google/`, Chromium answered ERR_NAME_NOT_RESOLVED and the route
// logged a 502 ERROR for a typo. Words are a search; a bad address is a 4xx.
describe('plain words become a web search, addresses stay addresses', () => {
  it('turns a single dotless label or free text into the search URL', () => {
    assert.equal(sanitizeNavigateUrl('google'), `${DEFAULT_SEARCH_URL}google`);
    assert.equal(sanitizeNavigateUrl('  wikipedia '), `${DEFAULT_SEARCH_URL}wikipedia`);
    assert.equal(sanitizeNavigateUrl('clima en lima'), `${DEFAULT_SEARCH_URL}clima%20en%20lima`);
    assert.equal(sanitizeNavigateUrl('qué   es   scopus'), `${DEFAULT_SEARCH_URL}qu%C3%A9%20es%20scopus`);
    for (const raw of ['google', 'clima en lima', 'noticias hoy']) assert.equal(looksLikeSearchQuery(raw), true, raw);
  });

  it('caps the query length and honours a configured search engine', () => {
    const long = 'a'.repeat(400);
    const out = sanitizeNavigateUrl(long);
    assert.equal(out, `${DEFAULT_SEARCH_URL}${'a'.repeat(180)}`);
    assert.equal(searchUrlFor('sira', { SIRAGPT_COMPUTER_SEARCH_URL: 'https://duckduckgo.com/?q=' }), 'https://duckduckgo.com/?q=sira');
    assert.equal(sanitizeNavigateUrl('sira', { SIRAGPT_COMPUTER_SEARCH_URL: 'https://duckduckgo.com/?q=' }), 'https://duckduckgo.com/?q=sira');
    // A broken override never produces a non-http destination.
    assert.equal(searchUrlFor('sira', { SIRAGPT_COMPUTER_SEARCH_URL: 'javascript:alert(1)' }), `${DEFAULT_SEARCH_URL}sira`);
    assert.equal(searchUrlFor('sira', { SIRAGPT_COMPUTER_SEARCH_URL: 'not a url' }), `${DEFAULT_SEARCH_URL}sira`);
  });

  it('keeps dotted hosts, localhost, IP literals, ports, paths and explicit schemes as addresses', () => {
    const cases = [
      ['scopus.com', 'https://scopus.com/'],
      ['localhost', 'https://localhost/'],
      ['localhost:3000/admin', 'https://localhost:3000/admin'],
      ['127.0.0.1', 'https://127.0.0.1/'],
      ['intranet:8080', 'https://intranet:8080/'],
      ['http://intranet', 'http://intranet/'],
      ['www.google.com/search?q=hello world', 'https://www.google.com/search?q=hello%20world'],
      ['example.com/a b', 'https://example.com/a%20b'],
    ];
    for (const [input, expected] of cases) {
      assert.equal(looksLikeSearchQuery(input), false, input);
      assert.equal(sanitizeNavigateUrl(input), expected, input);
    }
  });

  it('still refuses empty input, blocked schemes and unparsable addresses', () => {
    for (const raw of ['', '   ', 'javascript:alert(1)', 'about:blank', '://missing-scheme', 'https://']) throwsInvalid(raw);
  });
});

describe('navigation failures are classified by cause', () => {
  const chromium = (code, url) => Object.assign(new Error(`page.goto: net::${code} at ${url}\nCall log:\n  - navigating to "${url}", waiting until "domcontentloaded"`), { name: 'Error' });

  it('an unresolvable host is the caller\'s 4xx and names the host', () => {
    const out = classifyNavigationFailure(chromium('ERR_NAME_NOT_RESOLVED', 'https://google/'), 'https://google/');
    assert.equal(out.code, 'navigate_host_unresolved');
    assert.equal(out.status, 422);
    assert.match(out.message, /No se encontró el sitio «google»/);
    assert.match(out.message, /«google\.com»/);
    assert.ok(out.message.length <= 180, 'message fits the public error cap');
    assert.doesNotMatch(out.message, /page\.goto|Call log|net::/);
  });

  it('invalid addresses are 422, unreachable or insecure sites 502, slow sites 504', () => {
    assert.deepEqual(
      pick(classifyNavigationFailure(chromium('ERR_INVALID_URL', 'https://x/'), 'https://x/')),
      { code: 'navigate_url_invalid', status: 422 },
    );
    const refused = classifyNavigationFailure(chromium('ERR_CONNECTION_REFUSED', 'https://intranet.local/'), 'https://intranet.local/');
    assert.deepEqual(pick(refused), { code: 'navigate_site_unreachable', status: 502 });
    assert.match(refused.message, /«intranet\.local»/);
    assert.deepEqual(
      pick(classifyNavigationFailure(chromium('ERR_CERT_AUTHORITY_INVALID', 'https://self.signed/'), 'https://self.signed/')),
      { code: 'navigate_tls_failed', status: 502 },
    );
    const slow = classifyNavigationFailure(new Error('page.goto: Timeout 15000ms exceeded.'), 'https://slow.example/');
    assert.deepEqual(pick(slow), { code: 'navigate_timeout', status: 504 });
    assert.match(slow.message, /«slow\.example» tardó demasiado/);
  });

  it('leaves unknown failures to the generic navigate_failed path', () => {
    assert.equal(classifyNavigationFailure(new Error('browserContext.newPage: Target page, context or browser has been closed'), 'https://a.b/'), null);
    assert.equal(classifyNavigationFailure(null, 'https://a.b/'), null);
    assert.equal(classifyNavigationFailure(new Error(''), 'https://a.b/'), null);
  });

  it('is what POST /agent-computer/navigate uses before answering', () => {
    assert.match(route, /classifyNavigationFailure\(cause, url\)/);
    assert.match(route, /err\.status = classified \? classified\.status : 502/);
  });

  function pick(out) { return { code: out.code, status: out.status }; }
});
