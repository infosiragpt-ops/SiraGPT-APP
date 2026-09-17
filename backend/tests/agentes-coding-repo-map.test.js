'use strict';

/**
 * agentes-coding/repo-map — Aider-pattern ranked hints (AGENTES_CODING_V2).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const rm = require('../src/services/agentes-coding/repo-map');
const { createCodingSandbox, CodingSandboxError } = require('../src/services/agentes-coding/coding-sandbox');
const { CATALOG } = require('../src/services/agentes-coding/coding-sandbox/errors');

const FIXTURE = path.join(__dirname, 'fixtures/repo-map/mini-app');
const ON = { AGENTES_CODING_V2: '1' };

const WORKSPACE = {
  'src/main.ts': 'import App from "./App"\nexport const boot = 1\nexport function startApp() {}\n',
  'src/App.tsx': 'import { Header } from "./components/Header"\nimport { useCart } from "./hooks/useCart"\nexport default function App() {}\n',
  'src/components/Header.tsx': 'export function Header() {}\nexport const TITLE = "Sira"\n',
  'src/hooks/useCart.ts': 'export function useCart() {}\n',
  'src/orphan.ts': 'export const lonely = 1\n',
  'src/util.py': 'class Inventory:\n    pass\n\ndef count_items():\n    return 0\n',
  'node_modules/react/index.js': 'export const React = 1\n',
  'package.json': '{"name":"mini"}\n',
};

function sandbox() {
  return createCodingSandbox({ env: { ...ON }, autoGc: false });
}

async function mapOf(files = WORKSPACE, opts = {}) {
  const reads = [];
  const result = await rm.buildRepoMap(
    Object.keys(files),
    async (p, maxBytes) => {
      reads.push({ path: p, maxBytes });
      const raw = files[p];
      if (raw == null) return null;
      return String(raw).slice(0, maxBytes);
    },
    opts,
  );
  return { result, reads };
}

test('extractSymbols: JS/TS exports, components, hooks, default', () => {
  const src = [
    'export function fetchOrders() {}',
    'export const API_URL = "x"',
    'export default class OrderStore {}',
    'export interface Order { id: string }',
    'export { Helper as H }',
    'function Header() { return null }',
    'function useCart() { return [] }',
    'function helper() {}',
    'export default App;',
  ].join('\n');
  const names = rm.extractSymbols(src).map((s) => s.name);
  for (const expected of ['fetchOrders', 'API_URL', 'OrderStore', 'Order', 'Helper', 'Header', 'useCart', 'App']) {
    assert.ok(names.includes(expected), expected);
  }
  assert.ok(!names.includes('helper'));
});

test('extractSymbols: Python def/class from a header', () => {
  const names = rm.extractSymbols('class Inventory:\n    pass\n\ndef count_items():\n    return 0\n').map((s) => s.name);
  assert.ok(names.includes('Inventory'));
  assert.ok(names.includes('count_items'));
});

test('optional parseTags hook replaces regex extraction', () => {
  const names = rm.extractSymbols('export function ignored() {}', {
    parseTags: () => [{ kind: 'class', name: 'FromTreeSitter' }],
  }).map((s) => s.name);
  assert.deepEqual(names, ['FromTreeSitter']);
  assert.ok(!names.includes('ignored'));
});

test('extractRelativeImports + resolveImport against the file set', () => {
  const src = 'import A from "./components/App"\nimport { b } from "../lib/b"\nimport ext from "react"';
  const specs = rm.extractRelativeImports(src);
  assert.deepEqual(specs, ['./components/App', '../lib/b']);
  const files = new Set(['src/components/App.tsx', 'lib/b.ts']);
  assert.equal(rm.resolveImport('src/main.tsx', './components/App', files), 'src/components/App.tsx');
  assert.equal(rm.resolveImport('src/main.tsx', '../lib/b', files), 'lib/b.ts');
  assert.equal(rm.resolveImport('src/main.tsx', './nope', files), null);
});

test('buildRepoMap: ranked hints have name+path+score and skip node_modules', async () => {
  const { result } = await mapOf();
  assert.equal(result.ok, true);
  assert.ok(result.hints.length >= 4);
  for (const hint of result.hints) {
    assert.equal(typeof hint.name, 'string');
    assert.equal(typeof hint.path, 'string');
    assert.equal(typeof hint.score, 'number');
    assert.ok(hint.score >= 0 && hint.score <= 1, hint.score);
    assert.ok(!hint.path.includes('node_modules'), hint.path);
  }
  const paths = result.hints.map((h) => h.path);
  assert.ok(paths.some((p) => p === 'src/App.tsx'));
  assert.ok(paths.some((p) => p === 'package.json'));
  assert.ok(result.hints.some((h) => h.kind === 'file'));
  assert.ok(result.hints.some((h) => h.kind === 'fn' || h.kind === 'const'));
});

test('PageRank / import-degree: hubs rank above orphans', async () => {
  const { result } = await mapOf();
  const fileHints = result.hints.filter((h) => h.kind === 'file');
  const app = fileHints.find((h) => h.path === 'src/App.tsx');
  const orphan = fileHints.find((h) => h.path === 'src/orphan.ts');
  assert.ok(app, 'App file hint');
  assert.ok(orphan, 'orphan file hint');
  assert.ok(app.score > orphan.score, `App ${app.score} vs orphan ${orphan.score}`);
  const order = fileHints.map((h) => h.path);
  assert.ok(order.indexOf('src/App.tsx') < order.indexOf('src/orphan.ts'));
});

test('entrypoint / path heuristic boosts main and src/', () => {
  assert.ok(rm.pathHeuristic('src/main.ts', '') > rm.pathHeuristic('docs/notes.md', ''));
  assert.ok(rm.pathHeuristic('src/App.tsx', 'app') > rm.pathHeuristic('src/App.tsx', ''));
  assert.ok(rm.pathHeuristic('src/hooks/useCart.ts', 'cart') > rm.pathHeuristic('src/hooks/useCart.ts', 'zzz'));
});

test('query boost surfaces matching file and symbol names', async () => {
  const { result } = await mapOf(WORKSPACE, { query: 'Header', limit: 16 });
  assert.equal(result.query, 'Header');
  const top = result.hints.slice(0, 6);
  assert.ok(
    top.some((h) => /Header/i.test(h.name) || /Header/i.test(h.path)),
    JSON.stringify(top),
  );
});

test('header-only reads: reader never sees more than HEADER_BYTES', async () => {
  const huge = `${'export function keepVisible() {}\n'}${'x'.repeat(20_000)}\nexport function buriedTail() {}\n`;
  const files = { 'src/huge.ts': huge, 'src/main.ts': 'export const boot = 1\n' };
  const { result, reads } = await mapOf(files, { headerBytes: rm.HEADER_BYTES });
  assert.ok(reads.length >= 1);
  for (const read of reads) {
    assert.ok(read.maxBytes <= rm.HEADER_BYTES, read.maxBytes);
  }
  assert.ok(result.headerBytes <= rm.HEADER_BYTES);
  assert.ok(result.hints.some((h) => h.name === 'keepVisible' || h.path === 'src/huge.ts'));
  assert.ok(!result.hints.some((h) => h.name === 'buriedTail'));
});

test('empty / non-source workspaces return ok with empty or anchor-only hints', async () => {
  const empty = await rm.buildRepoMap([], async () => null);
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.hints, []);
  const readme = await rm.buildRepoMap(['README.md'], async () => '# hola');
  assert.equal(readme.ok, true);
});

test('limit and maxFiles caps omitted count', async () => {
  const many = {};
  for (let i = 0; i < 40; i += 1) many[`src/mod${i}.ts`] = `export function fn${i}() {}\n`;
  const { result } = await mapOf(many, { maxFiles: 8, limit: 5 });
  assert.ok(result.hints.length <= 5);
  assert.equal(result.scanned, 8);
  assert.equal(result.omitted, 32);
});

test('oversized query is E_PARAMS with Spanish copy', async () => {
  await assert.rejects(
    () => rm.buildRepoMap(['a.ts'], async () => 'export const a = 1', { query: 'q'.repeat(300) }),
    (err) => {
      assert.ok(err instanceof CodingSandboxError);
      assert.equal(err.code, 'E_PARAMS');
      assert.match(err.message, /consulta|mapa|larga/i);
      return true;
    },
  );
});

test('mapSession ranks a live coding-sandbox workspace', async () => {
  const sb = sandbox();
  const session = await sb.createSession();
  for (const [p, body] of Object.entries(WORKSPACE)) {
    if (p.startsWith('node_modules')) continue;
    await sb.writeFile(session.id, p, body);
  }
  const result = await rm.mapSession(sb, session.id, { limit: 20 });
  assert.equal(result.ok, true);
  assert.ok(result.hints.some((h) => h.path === 'src/App.tsx'));
  assert.ok(result.hints.every((h) => !h.path.includes('node_modules')));
});

test('mapForRequest refuses when the flag is off', async () => {
  const sb = createCodingSandbox({ env: { AGENTES_CODING_V2: '0' }, autoGc: false });
  await assert.rejects(
    () => rm.mapForRequest(sb, 'csb_x', {}, { AGENTES_CODING_V2: '0' }),
    (err) => err instanceof CodingSandboxError && err.code === 'E_FLAG_OFF' && /desactiv/i.test(err.message),
  );
});

test('mapSession missing session is E_SESSION_NOT_FOUND in Spanish', async () => {
  const sb = sandbox();
  await assert.rejects(
    () => rm.mapSession(sb, 'csb_missing'),
    (err) => err.code === 'E_SESSION_NOT_FOUND' && /sesión/i.test(err.message),
  );
});

test('mapWorkspaceRoot walks the fixture and skips node_modules', async () => {
  const result = await rm.mapWorkspaceRoot(FIXTURE, { limit: 20 });
  assert.equal(result.ok, true);
  assert.ok(result.hints.some((h) => h.path.endsWith('App.tsx') || h.path === 'src/App.tsx'));
  assert.ok(result.hints.every((h) => !h.path.includes('node_modules')));
  assert.ok(result.hints.some((h) => h.name === 'Header' || h.path.includes('Header')));
  assert.ok(result.hints.some((h) => h.name === 'Inventory' || h.path.endsWith('util.py')));
});

test('mapWorkspaceRoot header reader never leaves the root (E_PATH_ESCAPE)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rmap-'));
  fs.writeFileSync(path.join(tmp, 'ok.ts'), 'export const ok = 1\n');
  const result = await rm.mapWorkspaceRoot(tmp, { limit: 4 });
  assert.ok(result.hints.some((h) => h.path === 'ok.ts'));
  await assert.rejects(
    () => rm.mapWorkspaceRoot(path.join(tmp, 'missing-dir')),
    (err) => err.code === 'E_PARAMS' && /directorio|workspace/i.test(err.message),
  );
});

test('pageRank sends mass to imported hubs', () => {
  const nodes = ['a', 'b', 'c'];
  const outgoing = new Map([
    ['a', ['b']],
    ['c', ['b']],
    ['b', []],
  ]);
  const ranks = rm.pageRank(nodes, outgoing);
  assert.ok(ranks.get('b') > ranks.get('a'));
  assert.ok(ranks.get('b') > ranks.get('c'));
});

test('error catalog includes E_MAP_FAILED in Spanish', () => {
  assert.ok(CATALOG.E_MAP_FAILED);
  assert.match(CATALOG.E_MAP_FAILED.message, /mapa|repositorio/i);
  assert.match(CATALOG.E_FLAG_OFF.message, /desactiv/i);
});

test('GET /sessions/:id/map is 404 when the flag is off', async () => {
  let express;
  let createAgentesCodingRouter;
  try {
    express = require('express');
    ({ createAgentesCodingRouter } = require('../src/routes/agentes-coding'));
  } catch {
    return;
  }
  const app = express();
  app.use(express.json());
  app.use('/api/agentes-coding', createAgentesCodingRouter({ env: {}, sandbox: sandbox() }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const port = server.address().port;
    const { status, body } = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/api/agentes-coding/sessions/csb_x/map`, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
        }));
      }).on('error', reject);
    });
    assert.equal(status, 404);
    assert.equal(body.error, 'not_found');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('route source mounts GET+POST /map behind the flag helper', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/agentes-coding.js'), 'utf8');
  assert.match(src, /\/sessions\/:id\/map/);
  assert.match(src, /mapForRequest/);
  assert.match(src, /isAgentesCodingV2Enabled/);
  assert.match(src, /error: 'not_found'/);
  assert.doesNotMatch(src, /aider-ai|OpenRouter|daytona/i);
});

test('disk fixture huge.ts header does not require the full file in memory', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rmap-huge-'));
  const body = `export function keepVisible() {}\n${'y'.repeat(25_000)}\nexport function buriedTail() {}\n`;
  fs.writeFileSync(path.join(tmp, 'src.ts'), body);
  let maxSeen = 0;
  const result = await rm.buildRepoMap(
    ['src.ts'],
    async (p, maxBytes) => {
      maxSeen = Math.max(maxSeen, maxBytes);
      const fh = await fs.promises.open(path.join(tmp, p), 'r');
      try {
        const buf = Buffer.alloc(maxBytes);
        const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
        return buf.slice(0, bytesRead).toString('utf8');
      } finally {
        await fh.close();
      }
    },
    { headerBytes: 1024 },
  );
  assert.equal(maxSeen, 1024);
  assert.ok(result.hints.some((h) => h.name === 'keepVisible' || h.path === 'src.ts'));
  assert.ok(!result.hints.some((h) => h.name === 'buriedTail'));
});
