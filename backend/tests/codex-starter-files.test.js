'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { starterFiles, escapeHtml } = require('../src/services/codex/starter-files');

test('same input produces byte-identical output (deterministic)', () => {
  const a = starterFiles({ projectName: 'Mi tienda' });
  const b = starterFiles({ projectName: 'Mi tienda' });
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('emits a runnable Vite project: package.json + index.html + src/main.js + .gitignore', () => {
  const files = starterFiles({ projectName: 'Demo' });
  const paths = files.map((f) => f.path);
  assert.deepEqual(paths, ['package.json', 'index.html', 'src/main.js', '.gitignore']);
  const pkg = JSON.parse(files[0].content);
  assert.equal(pkg.scripts.dev, 'vite');
  assert.ok(pkg.devDependencies.vite);
  assert.match(files[1].content, /src\/main\.js/);
  assert.match(files[3].content, /node_modules/);
});

test('project name is HTML-escaped (anti-injection)', () => {
  const files = starterFiles({ projectName: '<script>alert(1)</script>' });
  const html = files.find((f) => f.path === 'index.html').content;
  assert.ok(!html.includes('<script>alert'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.equal(escapeHtml(`a&<>"'b`), 'a&amp;&lt;&gt;&quot;&#39;b');
});

test('empty or missing name falls back to a default', () => {
  const html = starterFiles({}).find((f) => f.path === 'index.html').content;
  assert.match(html, /Proyecto Codex/);
});
