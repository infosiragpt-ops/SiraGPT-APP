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
    'src/lib/ai.ts', 'src/lib/storage.ts',
    'src/ui/button.tsx', 'src/ui/card.tsx', 'src/ui/input.tsx', 'src/ui/badge.tsx', 'src/ui/index.ts',
    '.gitignore',
  ]);
  const pkg = JSON.parse(files.find((f) => f.path === 'package.json').content);
  assert.equal(pkg.scripts.dev, 'vite');
  assert.ok(pkg.dependencies.react && pkg.dependencies['react-dom'], 'react runtime');
  assert.ok(pkg.devDependencies['@vitejs/plugin-react'], 'vite react plugin');
  assert.ok(pkg.devDependencies.vite && pkg.devDependencies.typescript);
  // Tailwind v4 design system: plugin wired, entry css imports tailwind and
  // defines the theme tokens the UI kit classes (bg-surface, text-fg…) map to.
  assert.ok(pkg.devDependencies.tailwindcss && pkg.devDependencies['@tailwindcss/vite'], 'tailwind v4');
  const viteCfg = files.find((f) => f.path === 'vite.config.ts').content;
  assert.match(viteCfg, /tailwindcss\(\)/);
  const css = files.find((f) => f.path === 'src/index.css').content;
  assert.match(css, /@import "tailwindcss"/);
  assert.match(css, /@theme inline/);
  assert.match(css, /--color-accent/);
  // The starter App dogfoods the kit so the model sees the intended idiom.
  const app = files.find((f) => f.path === 'src/App.tsx').content;
  assert.match(app, /from '\.\/ui'/);
  assert.match(app, /Workspace listo/);
  // Persistent KV storage helper: server-side persistence with personal +
  // shared scopes (the apps' real data store, not just localStorage).
  const storage = files.find((f) => f.path === 'src/lib/storage.ts').content;
  assert.match(storage, /export const storage/);
  assert.match(storage, /\/api\/apps-kv\//);
  assert.match(storage, /shared:/);
  // index.html mounts the TSX entry into #root.
  const html = files.find((f) => f.path === 'index.html').content;
  assert.match(html, /<div id="root">/);
  assert.match(html, /src="\/src\/main\.tsx"/);
  assert.match(files.find((f) => f.path === '.gitignore').content, /node_modules/);
  // Vite 7 host-checks the Host header: without allowedHosts the platform
  // proxy and the browser verifier (http://runner:5173) get 403 Blocked.
  const vite = files.find((f) => f.path === 'vite.config.ts').content;
  assert.match(vite, /allowedHosts:\s*true/);
  assert.match(vite, /host:\s*true/);
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

test('full-stack starter runs on the Bun runner AND behind the tokenized base', () => {
  const { fullStackStarterFiles } = require('../src/services/codex/starter-files');
  const files = fullStackStarterFiles({ projectName: 'Demo FS' });
  const by = (path) => files.find((f) => f.path === path);
  const pkg = JSON.parse(by('package.json').content);
  // No native deps (better-sqlite3's build script exits 127 in the slim Bun
  // image) and no `npm run` nesting (the runner has no npm).
  assert.equal(pkg.dependencies['better-sqlite3'], undefined);
  assert.match(pkg.scripts.dev, /concurrently/);
  assert.doesNotMatch(pkg.scripts.dev, /npm run/);
  // Built-in sqlite drivers behind the adapter; server imports it.
  const db = by('server/db.js').content;
  assert.match(db, /bun:sqlite/);
  assert.match(db, /node:sqlite/);
  assert.match(by('server/index.js').content, /from '\.\/db\.js'/);
  // Vite reads port/base from env (the runner launches `bun run dev`, no CLI
  // flags reach the inner vite) and the /api proxy matches under ANY base.
  const vite = by('vite.config.ts').content;
  assert.match(vite, /process\.env\.PORT/);
  assert.match(vite, /process\.env\.VITE_BASE/);
  assert.match(vite, /\^\.\*\/api\//);
  // Frontend prefixes API calls with BASE_URL — a bare /api escapes the base.
  const app = by('src/App.tsx').content;
  assert.match(app, /import\.meta\.env\.BASE_URL/);
  assert.doesNotMatch(app, /fetch\('\/api\//);
});

test('empty or missing name falls back to a default', () => {
  const html = starterFiles({}).find((f) => f.path === 'index.html').content;
  assert.match(html, /Proyecto Codex/);
});
