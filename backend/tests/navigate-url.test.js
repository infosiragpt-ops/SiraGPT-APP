'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { sanitizeNavigateUrl } = require('../src/services/computer/navigate-url');

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
