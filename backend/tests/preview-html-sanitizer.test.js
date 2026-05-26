/**
 * Tests for services/preview-html-sanitizer.js — HTML preview
 * sanitizer used to neutralize untrusted HTML before rendering in
 * preview iframes.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  sanitizeCss,
  sanitizePreviewHtml,
} = require('../src/services/preview-html-sanitizer');

// ── sanitizeCss ──────────────────────────────────────────────────

describe('sanitizeCss', () => {
  it('returns empty string for nullish input', () => {
    assert.equal(sanitizeCss(null), '');
    assert.equal(sanitizeCss(undefined), '');
    assert.equal(sanitizeCss(''), '');
  });

  it('strips @import rules', () => {
    const css = '@import url("https://evil.com/steal.css"); body { color: red; }';
    const out = sanitizeCss(css);
    assert.equal(out.includes('@import'), false);
    assert.match(out, /body \{ color: red; \}/);
  });

  it('strips multi-line @import variants', () => {
    const css = '@import "evil.css"; @import url(other.css);';
    const out = sanitizeCss(css);
    assert.equal(out.includes('@import'), false);
  });

  it('strips url() calls (prevents external resource exfil)', () => {
    const css = 'body { background: url("https://evil.com/track.png"); }';
    const out = sanitizeCss(css);
    assert.equal(out.includes('url('), false);
    assert.match(out, /body \{ background: ; \}/);
  });

  it('strips expression() (IE6-era XSS vector)', () => {
    const css = 'div { width: expression(alert(1)); }';
    const out = sanitizeCss(css);
    assert.equal(out.includes('expression('), false);
  });

  it('strips "javascript:" anywhere in the CSS', () => {
    const css = 'a { content: "javascript:alert(1)"; }';
    const out = sanitizeCss(css);
    assert.equal(out.toLowerCase().includes('javascript:'), false);
  });

  it('is case-insensitive', () => {
    const css = '@IMPORT "x"; div { background: URL(y); a: EXPRESSION(b); c: JAVASCRIPT:d; }';
    const out = sanitizeCss(css);
    const lower = out.toLowerCase();
    assert.equal(lower.includes('@import'), false);
    assert.equal(lower.includes('url('), false);
    assert.equal(lower.includes('expression('), false);
    assert.equal(lower.includes('javascript:'), false);
  });

  it('preserves safe CSS unchanged', () => {
    const css = '.btn { color: #fff; padding: 8px; border-radius: 4px; }';
    assert.equal(sanitizeCss(css), css);
  });
});

// ── sanitizePreviewHtml · blocked tags ───────────────────────────

describe('sanitizePreviewHtml · blocked tags', () => {
  const blocked = ['script', 'iframe', 'object', 'embed', 'base', 'link', 'meta', 'form', 'input', 'button', 'textarea', 'select', 'option'];

  for (const tag of blocked) {
    it(`strips <${tag}>`, () => {
      const html = `<div>before<${tag}>inner</${tag}>after</div>`;
      const out = sanitizePreviewHtml(html);
      assert.equal(out.toLowerCase().includes(`<${tag}`), false, `<${tag}> tag should be removed`);
    });
  }

  it('preserves benign tags (p, div, span, h1, ul, li, a, img, table, ...)', () => {
    const html = '<p>x</p><div>y</div><span>z</span><h1>t</h1><ul><li>i</li></ul>';
    const out = sanitizePreviewHtml(html);
    for (const tag of ['p', 'div', 'span', 'h1', 'ul', 'li']) {
      assert.ok(out.includes(`<${tag}`), `<${tag}> should be preserved`);
    }
  });
});

// ── sanitizePreviewHtml · event handlers + srcdoc ───────────────

describe('sanitizePreviewHtml · event handlers + srcdoc', () => {
  it('removes onclick / onerror / onload / on* event handlers', () => {
    const html = `<div onclick="evil()" onmouseover="bad()">x</div>`;
    const out = sanitizePreviewHtml(html);
    assert.equal(out.includes('onclick'), false);
    assert.equal(out.includes('onmouseover'), false);
  });

  it('removes uppercase ONCLICK variants', () => {
    const html = `<div ONCLICK="evil()">x</div>`;
    const out = sanitizePreviewHtml(html);
    assert.equal(out.toLowerCase().includes('onclick'), false);
  });

  it('removes srcdoc attribute (iframe escape hatch)', () => {
    const html = `<div srcdoc="<script>alert(1)</script>">x</div>`;
    const out = sanitizePreviewHtml(html);
    assert.equal(out.toLowerCase().includes('srcdoc'), false);
  });
});

// ── sanitizePreviewHtml · inline style stripping ────────────────

describe('sanitizePreviewHtml · inline style', () => {
  it('removes inline style= attribute from elements', () => {
    const html = `<div style="color: red; expression(alert(1))">x</div>`;
    const out = sanitizePreviewHtml(html);
    assert.equal(out.includes('style='), false);
    // Element itself is preserved.
    assert.match(out, /<div[^>]*>x<\/div>/);
  });

  it('does NOT strip the contents of <style> tags — those go through sanitizeCss', () => {
    const html = '<style>.a { color: red; }</style><p>hi</p>';
    const out = sanitizePreviewHtml(html);
    assert.match(out, /<style>.*\.a \{ color: red; \}.*<\/style>/s);
  });

  it('does sanitize CSS inside <style>', () => {
    const html = '<style>@import "evil.css"; .a { background: url(x); }</style>';
    const out = sanitizePreviewHtml(html);
    assert.equal(out.includes('@import'), false);
    assert.equal(out.includes('url('), false);
  });
});

// ── sanitizePreviewHtml · URL attribute filtering ───────────────

describe('sanitizePreviewHtml · href/src/xlink:href filtering', () => {
  it('keeps a safe https href', () => {
    const out = sanitizePreviewHtml('<a href="https://example.com">link</a>');
    assert.match(out, /href="https:\/\/example\.com"/);
  });

  it('keeps an in-document #anchor href', () => {
    const out = sanitizePreviewHtml('<a href="#section-1">link</a>');
    assert.match(out, /href="#section-1"/);
  });

  it('keeps a mailto href', () => {
    const out = sanitizePreviewHtml('<a href="mailto:test@example.com">email</a>');
    assert.match(out, /href="mailto:test@example\.com"/);
  });

  it('strips a javascript: href', () => {
    const out = sanitizePreviewHtml('<a href="javascript:alert(1)">x</a>');
    assert.equal(out.includes('javascript:'), false);
    assert.equal(out.includes('href='), false);
  });

  it('strips a data: href on anchor tag (only allowed for images)', () => {
    const out = sanitizePreviewHtml('<a href="data:text/html,<script>1</script>">x</a>');
    assert.equal(out.includes('href='), false);
  });

  it('keeps data:image/png on <img>', () => {
    const out = sanitizePreviewHtml('<img src="data:image/png;base64,iVBORw0KGgo=" alt="x">');
    assert.match(out, /src="data:image\/png;base64,iVBORw0KGgo="/);
  });

  it('strips data:text/html on <img> (only image data URIs allowed)', () => {
    const out = sanitizePreviewHtml('<img src="data:text/html,<script>1</script>">');
    assert.equal(out.includes('data:'), false);
    assert.equal(out.includes('src='), false);
  });

  it('strips https:// src on <img> (data URIs only for inline images)', () => {
    // Per isSafeUrl logic: image=true means https is NOT safe (image=true
    // && /^https?:/ returns !image = false). Pin this strict behavior.
    const out = sanitizePreviewHtml('<img src="https://evil.com/track.gif">');
    assert.equal(out.includes('https://evil.com'), false);
  });

  it('strips empty/whitespace href', () => {
    const out = sanitizePreviewHtml('<a href="  ">x</a>');
    assert.equal(out.includes('href='), false);
  });

  it('strips xlink:href (SVG escape hatch)', () => {
    const out = sanitizePreviewHtml('<svg><use xlink:href="javascript:alert(1)"/></svg>');
    assert.equal(out.toLowerCase().includes('javascript'), false);
  });
});

// ── sanitizePreviewHtml · misc edges ─────────────────────────────

describe('sanitizePreviewHtml · edges', () => {
  it('null / empty / non-string input does not throw', () => {
    sanitizePreviewHtml(null);
    sanitizePreviewHtml('');
    sanitizePreviewHtml(undefined);
    sanitizePreviewHtml(42);
  });

  it('preserves visible text content', () => {
    const out = sanitizePreviewHtml('<p>Hello, world!</p>');
    assert.match(out, /Hello, world!/);
  });

  it('preserves attribute order is not strict — but data-* attrs survive', () => {
    const out = sanitizePreviewHtml('<div data-id="42" data-info="x">y</div>');
    assert.match(out, /data-id="42"/);
    assert.match(out, /data-info="x"/);
  });
});

// ── module surface ───────────────────────────────────────────────

describe('module surface', () => {
  it('exports exactly { sanitizeCss, sanitizePreviewHtml }', () => {
    const mod = require('../src/services/preview-html-sanitizer');
    const keys = Object.keys(mod).sort();
    assert.deepEqual(keys, ['sanitizeCss', 'sanitizePreviewHtml']);
  });
});
