'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-pwa-manifest');
const { extractPwaManifest, buildPwaManifestForFiles, renderPwaManifestBlock } = engine;

const MANIFEST = `{
  "name": "My App",
  "short_name": "App",
  "description": "PWA example",
  "display": "standalone",
  "start_url": "/",
  "scope": "/",
  "theme_color": "#123456",
  "background_color": "#ffffff",
  "orientation": "portrait-primary",
  "icons": [
    {"src": "/icon.png", "sizes": "512x512", "type": "image/png"}
  ]
}`;

test('empty / non-string tolerated', () => {
  assert.equal(extractPwaManifest('').total, 0);
  assert.equal(extractPwaManifest(null).total, 0);
});

test('detects manifest name', () => {
  const r = extractPwaManifest(MANIFEST);
  assert.ok(r.entries.some((e) => e.key === 'name'));
});

test('detects short_name', () => {
  const r = extractPwaManifest(MANIFEST);
  assert.ok(r.entries.some((e) => e.key === 'short_name'));
});

test('detects display: standalone', () => {
  const r = extractPwaManifest(MANIFEST);
  assert.ok(r.entries.some((e) => e.kind === 'display' && e.value === 'standalone'));
});

test('detects start_url', () => {
  const r = extractPwaManifest(MANIFEST);
  assert.ok(r.entries.some((e) => e.key === 'start_url'));
});

test('detects theme_color', () => {
  const r = extractPwaManifest(MANIFEST);
  assert.ok(r.entries.some((e) => e.key === 'theme_color' && /#123456/.test(e.value)));
});

test('detects orientation', () => {
  const r = extractPwaManifest(MANIFEST);
  assert.ok(r.entries.some((e) => e.kind === 'orientation'));
});

test('counts icons arrays', () => {
  const r = extractPwaManifest(MANIFEST);
  assert.ok(r.totals.icons >= 1);
});

test('detects service worker registration', () => {
  const r = extractPwaManifest('navigator.serviceWorker.register("/sw.js")');
  assert.ok(r.totals.serviceWorker >= 1);
});

test('detects /sw.js path', () => {
  const r = extractPwaManifest('Load /sw.js as worker');
  assert.ok(r.totals.serviceWorker >= 1);
});

test('dedupes identical entries', () => {
  const r = extractPwaManifest('"name": "App"\n"name": "App"');
  assert.equal(r.entries.filter((e) => e.key === 'name' && e.value === 'App').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) text += `"name": "App ${i}"\n`;
  const r = extractPwaManifest(text);
  assert.ok(r.entries.length <= 18);
});

test('counts totals by kind', () => {
  const r = extractPwaManifest(MANIFEST);
  assert.ok(r.totals.meta >= 1);
  assert.ok(r.totals.display >= 1);
  assert.ok(r.totals.url >= 1);
  assert.ok(r.totals.color >= 1);
});

test('buildPwaManifestForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.json', extractedText: '"name": "App A"' },
    { name: 'b.json', extractedText: '"name": "App B"' },
  ];
  const r = buildPwaManifestForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderPwaManifestBlock returns markdown when entries exist', () => {
  const files = [{ name: 'manifest.json', extractedText: MANIFEST }];
  const r = buildPwaManifestForFiles(files);
  const md = renderPwaManifestBlock(r);
  assert.match(md, /^## PWA/);
});

test('renderPwaManifestBlock empty when nothing surfaces', () => {
  assert.equal(renderPwaManifestBlock({ perFile: [] }), '');
  assert.equal(renderPwaManifestBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildPwaManifestForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '"name": "App"' },
  ]);
  assert.equal(r.perFile.length, 1);
});
