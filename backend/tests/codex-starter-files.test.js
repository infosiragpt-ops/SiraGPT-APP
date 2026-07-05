'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { starterFiles, escapeHtml } = require('../src/services/codex/starter-files');

// typescript is a frontend dev-dep; it may be absent in the backend test env.
// Load it best-effort so the parse-cleanliness check can skip instead of
// crashing the whole file on require().
let ts = null;
try { ts = require('typescript'); } catch { /* skip the TSX parse test */ }

test('same input produces byte-identical output (deterministic)', () => {
  const a = starterFiles({ projectName: 'Mi tienda' });
  const b = starterFiles({ projectName: 'Mi tienda' });
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('emits a runnable React 18 + Vite 7 + TS project', () => {
  const files = starterFiles({ projectName: 'Demo' });
  const paths = files.map((f) => f.path);
  assert.deepEqual(paths, [
    'package.json', 'vite.config.ts', 'tsconfig.json', 'index.html',
    'src/main.tsx', 'src/App.tsx', 'src/index.css',
    'src/lib/ai.ts', '.gitignore',
  ]);
  const pkg = JSON.parse(files.find((f) => f.path === 'package.json').content);
  assert.equal(pkg.scripts.dev, 'vite');
  assert.ok(pkg.dependencies.react && pkg.dependencies['react-dom'], 'react runtime');
  assert.ok(pkg.devDependencies['@vitejs/plugin-react'], 'vite react plugin');
  assert.ok(pkg.devDependencies.vite && pkg.devDependencies.typescript);
  // index.html mounts the TSX entry into #root.
  const html = files.find((f) => f.path === 'index.html').content;
  assert.match(html, /<div id="root">/);
  assert.match(html, /src="\/src\/main\.tsx"/);
  assert.match(files.find((f) => f.path === '.gitignore').content, /node_modules/);
});

test('the generated .tsx/.ts files parse cleanly (valid TypeScript/JSX)', { skip: !ts }, () => {
  for (const f of starterFiles({ projectName: 'Mi <b>App</b>' })) {
    if (!/\.(tsx?|ts)$/.test(f.path)) continue;
    const kind = f.path.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(f.path, f.content, ts.ScriptTarget.Latest, true, kind);
    assert.equal((sf.parseDiagnostics || []).length, 0, `${f.path} should parse`);
  }
});

test('project name is escaped everywhere (anti-injection)', () => {
  const files = starterFiles({ projectName: '<script>alert(1)</script>' });
  const html = files.find((f) => f.path === 'index.html').content;
  assert.ok(!html.includes('<script>alert'));
  assert.ok(html.includes('&lt;script&gt;'));
  // App.tsx embeds the name as JSX text — no raw tags/braces.
  const app = files.find((f) => f.path === 'src/App.tsx').content;
  assert.ok(!/<script>alert/.test(app));
  assert.equal(escapeHtml(`a&<>"'b`), 'a&amp;&lt;&gt;&quot;&#39;b');
});

test('empty or missing name falls back to a default', () => {
  const html = starterFiles({}).find((f) => f.path === 'index.html').content;
  assert.match(html, /Proyecto Codex/);
});
