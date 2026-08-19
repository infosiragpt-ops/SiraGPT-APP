'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-mjml');
const { extractMjml, buildMjmlForFiles, renderMjmlBlock, _internal } = engine;
const { classifyTag, isMjmlLike } = _internal;

const MJML_FIXTURE = `<mjml>
  <mj-head>
    <mj-preview>Welcome to ACME!</mj-preview>
    <mj-title>Welcome email</mj-title>
    <mj-font name="Roboto" href="https://fonts.googleapis.com/css?family=Roboto" />
    <mj-style>
      .my-class { color: red; }
    </mj-style>
    <mj-attributes>
      <mj-text font-family="Roboto, sans-serif" color="#333" />
    </mj-attributes>
  </mj-head>
  <mj-body background-color="#f0f0f0">
    <mj-section padding="20px">
      <mj-column width="50%">
        <mj-image src="https://example.com/logo.png" alt="Logo" />
        <mj-text font-size="16px" color="#000" align="left">
          Hello!
        </mj-text>
        <mj-button href="https://example.com/welcome" background-color="#007bff" color="#fff">
          Get started
        </mj-button>
      </mj-column>
    </mj-section>
    <mj-section>
      <mj-column>
        <mj-social>
          <mj-social-element name="twitter" href="https://twitter.com/acme" />
          <mj-social-element name="github" href="https://github.com/acme" />
        </mj-social>
        <mj-divider border-color="#ddd" />
        <mj-spacer height="20px" />
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`;

test('empty / non-string tolerated', () => {
  assert.equal(extractMjml('').total, 0);
  assert.equal(extractMjml(null).total, 0);
});

test('non-MJML text returns empty', () => {
  const r = extractMjml('<html><body>regular HTML</body></html>');
  assert.equal(r.total, 0);
});

test('classifyTag: root / layout / component / head / social', () => {
  assert.equal(classifyTag('mjml'), 'root');
  assert.equal(classifyTag('mj-section'), 'layout');
  assert.equal(classifyTag('mj-button'), 'component');
  assert.equal(classifyTag('mj-style'), 'head');
  assert.equal(classifyTag('mj-social'), 'social');
});

test('isMjmlLike heuristic', () => {
  assert.ok(isMjmlLike('<mjml><mj-body /></mjml>'));
  assert.ok(!isMjmlLike('plain text'));
});

test('detects <mjml> root', () => {
  const r = extractMjml(MJML_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'root' && e.name === 'mjml'));
});

test('detects layout tags (mj-section, mj-column)', () => {
  const r = extractMjml(MJML_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'layout' && e.name === 'mj-section'));
  assert.ok(r.entries.some((e) => e.kind === 'layout' && e.name === 'mj-column'));
});

test('detects component tags (mj-text, mj-button, mj-image)', () => {
  const r = extractMjml(MJML_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'component' && e.name === 'mj-text'));
  assert.ok(r.entries.some((e) => e.kind === 'component' && e.name === 'mj-button'));
  assert.ok(r.entries.some((e) => e.kind === 'component' && e.name === 'mj-image'));
});

test('detects head tags (mj-head, mj-style, mj-preview, mj-attributes)', () => {
  const r = extractMjml(MJML_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'head' && e.name === 'mj-head'));
  assert.ok(r.entries.some((e) => e.kind === 'head' && e.name === 'mj-attributes'));
});

test('detects social tags', () => {
  const r = extractMjml(MJML_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'social' && e.name === 'mj-social'));
});

test('detects mj-divider / mj-spacer components', () => {
  const r = extractMjml(MJML_FIXTURE);
  assert.ok(r.entries.some((e) => e.name === 'mj-divider'));
  assert.ok(r.entries.some((e) => e.name === 'mj-spacer'));
});

test('detects href URLs', () => {
  const r = extractMjml(MJML_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'href' && /example\.com\/welcome/.test(e.name)));
  assert.ok(r.entries.some((e) => e.kind === 'href' && /twitter\.com/.test(e.name)));
});

test('detects mj-image src', () => {
  const r = extractMjml(MJML_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'image' && /logo\.png/.test(e.name)));
});

test('detects mj-font name', () => {
  const r = extractMjml(MJML_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'font' && e.name === 'Roboto'));
});

test('detects mj-preview content', () => {
  const r = extractMjml(MJML_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'preview' && /Welcome to ACME/.test(e.name)));
});

test('counts mj-style blocks', () => {
  const r = extractMjml(MJML_FIXTURE);
  assert.ok(r.totals.styleBlock >= 1);
});

test('dedupes identical tags', () => {
  const r = extractMjml('<mjml><mj-section /><mj-section /></mjml>');
  assert.equal(r.entries.filter((e) => e.name === 'mj-section').length, 1);
});

test('caps entries per file', () => {
  let text = '<mjml><mj-body>';
  for (let i = 0; i < 40; i++) text += `<mj-section><mj-column /></mj-section>`;
  text += '</mj-body></mjml>';
  const r = extractMjml(text);
  assert.ok(r.entries.length <= 24);
});

test('counts totals by kind', () => {
  const r = extractMjml(MJML_FIXTURE);
  assert.ok(r.totals.layout >= 2);
  assert.ok(r.totals.component >= 3);
  assert.ok(r.totals.head >= 2);
});

test('buildMjmlForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.mjml', extractedText: '<mjml><mj-body><mj-text>A</mj-text></mj-body></mjml>' },
    { name: 'b.mjml', extractedText: '<mjml><mj-body><mj-button>B</mj-button></mj-body></mjml>' },
  ];
  const r = buildMjmlForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderMjmlBlock returns markdown when entries exist', () => {
  const files = [{ name: 'welcome.mjml', extractedText: MJML_FIXTURE }];
  const r = buildMjmlForFiles(files);
  const md = renderMjmlBlock(r);
  assert.match(md, /^## MJML/);
});

test('renderMjmlBlock empty when nothing surfaces', () => {
  assert.equal(renderMjmlBlock({ perFile: [] }), '');
  assert.equal(renderMjmlBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildMjmlForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: MJML_FIXTURE },
  ]);
  assert.equal(r.perFile.length, 1);
});
