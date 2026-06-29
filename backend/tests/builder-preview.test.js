'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildPreviewHtml, paletteFor, escapeHtml, appName } = require('../src/services/builder/preview');
const { scaffoldFromBrief } = require('../src/services/builder/scaffold');

function makeBrief(overrides = {}) {
  return {
    purpose: 'Vender cursos online',
    platform: 'web',
    audience: 'estudiantes',
    coreFeatures: ['pagos'],
    dataEntities: [{ name: 'Curso', fields: ['titulo'] }],
    style: { theme: 'oscuro', refs: [] },
    integrations: [],
    constraints: '',
    openQuestions: [],
    ...overrides,
  };
}

test('buildPreviewHtml returns a complete, self-contained HTML document', () => {
  const html = buildPreviewHtml(makeBrief());
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<\/html>\s*$/i);
  assert.ok(html.includes('Vender cursos online'), 'shows the purpose');
  assert.ok(html.includes('Home'), 'renders a blueprint page');
  assert.ok(!/<script/i.test(html), 'no executable script tags — safe for srcdoc');
});

test('buildPreviewHtml escapes user content (no HTML injection)', () => {
  const html = buildPreviewHtml(makeBrief({ purpose: '<script>alert(1)</script>' }));
  assert.ok(!html.includes('<script>alert(1)'), 'raw markup is not emitted');
  assert.ok(html.includes('&lt;script&gt;alert(1)'), 'dangerous chars are escaped');
});

test('paletteFor maps theme keywords and falls back to a default', () => {
  assert.equal(paletteFor('oscuro').primary, '#7c5cff');
  assert.equal(paletteFor('minimalista').bg, '#ffffff');
  assert.equal(paletteFor('corporativo').primary, '#1d4ed8');
  assert.equal(paletteFor('minimalista #FF0000').primary, '#FF0000');
  // unknown theme → default palette (still a valid hex primary)
  assert.match(paletteFor('lo-que-sea').primary, /^#[0-9a-f]{6}$/i);
});

test('platform drives the device frame', () => {
  assert.ok(buildPreviewHtml(makeBrief({ platform: 'web' })).includes('class="frame web"'));
  assert.ok(buildPreviewHtml(makeBrief({ platform: 'mobile' })).includes('class="frame mobile"'));
  const desktop = buildPreviewHtml(makeBrief({ platform: 'desktop' }));
  assert.ok(desktop.includes('class="frame desktop"'));
  assert.ok(desktop.includes('winbar'), 'desktop gets window chrome');
});

test('buildPreviewHtml rejects an invalid brief', () => {
  assert.throws(() => buildPreviewHtml({ platform: 'smartwatch' }), /invalid ProjectBrief/);
});

test('escapeHtml and appName behave', () => {
  assert.equal(escapeHtml('a & b < c > "d" \'e\''), 'a &amp; b &lt; c &gt; &quot;d&quot; &#39;e&#39;');
  assert.equal(appName({ purpose: 'Vender cursos online a todos' }), 'Vender cursos online a');
  assert.equal(appName({ purpose: '' }), 'Mi App');
});

test('scaffold now ships preview.html among the starter files', () => {
  const { files } = scaffoldFromBrief(makeBrief());
  const preview = files.find((f) => f.path === 'preview.html');
  assert.ok(preview, 'preview.html is present');
  assert.equal(preview.language, 'html');
  assert.match(preview.content, /^<!doctype html>/i);
});

test('appName truncates by code point — never splits a surrogate pair (emoji)', () => {
  // 40 emoji, each a UTF-16 surrogate pair. Slicing at 38 code UNITS would cut
  // the 19th emoji in half and emit a lone surrogate before the ellipsis.
  const name = appName({ purpose: '😀'.repeat(40) });
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  assert.ok(!loneSurrogate.test(name), `no lone surrogate in ${JSON.stringify(name)}`);
  assert.ok(name.endsWith('…'), 'long name is truncated with an ellipsis');
});
