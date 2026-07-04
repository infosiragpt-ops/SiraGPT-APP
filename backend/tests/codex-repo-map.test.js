'use strict';

/**
 * codex/repo-map — offline unit tests.
 *
 * Covers: symbol extraction (functions/consts/classes/types/components/
 * default), relative-import resolution, centrality ranking (imported-by
 * floats up), size bounds (chars cap + omitted note), skip rules
 * (node_modules etc.), runner failure modes, and the repo_map tool contract.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const rm = require('../src/services/codex/repo-map');
const buildTools = require('../src/services/codex/build-tools');

test('extractSymbols: exports, components, hooks, default', () => {
  const src = [
    'export function fetchOrders() {}',
    'export const API_URL = "x"',
    'export default class OrderStore {}',
    'export interface Order { id: string }',
    'function Header() { return null }',
    'function useCart() { return [] }',
    'function helper() {}', // lowercase non-hook → not a component symbol
    'export default App;',
  ].join('\n');
  const names = rm.extractSymbols(src).map((s) => s.name);
  for (const expected of ['fetchOrders', 'API_URL', 'OrderStore', 'Order', 'Header', 'useCart', 'App']) {
    assert.ok(names.includes(expected), expected);
  }
  assert.ok(!names.includes('helper'));
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

const WORKSPACE = {
  'src/main.tsx': 'import App from "./App"\nexport const boot = 1',
  'src/App.tsx': 'import { Header } from "./components/Header"\nimport { useCart } from "./hooks/useCart"\nexport default function App() {}',
  'src/components/Header.tsx': 'export function Header() {}',
  'src/hooks/useCart.ts': 'export function useCart() {}',
  'src/orphan.ts': 'export const lonely = 1',
  'node_modules/react/index.js': 'export const React = 1',
  'package.json': '{}',
};

async function mapOf(files = WORKSPACE, opts = {}) {
  return rm.buildRepoMapFromFiles(Object.keys(files), async (p) => files[p] ?? null, opts);
}

test('buildRepoMapFromFiles: ranked map with imported-by counts and anchors', async () => {
  const map = await mapOf();
  assert.match(map, /Mapa del repositorio/);
  assert.match(map, /package\.json/);
  assert.match(map, /src\/App\.tsx ←1: /, 'App imported by main');
  assert.match(map, /src\/components\/Header\.tsx ←1: Header/);
  assert.ok(!map.includes('node_modules'), 'skip rules applied');
  // Imported files rank above the orphan.
  assert.ok(map.indexOf('src/App.tsx') < map.indexOf('src/orphan.ts'));
});

test('buildRepoMapFromFiles: char budget enforced with omitted note', async () => {
  const many = {};
  for (let i = 0; i < 30; i++) many[`src/mod${i}.ts`] = `export function fn${i}() {}`;
  const map = await mapOf(many, { maxChars: 400 });
  // Budget bounds the ranked lines; the trailing "omitted" note may add ~70.
  assert.ok(map.length <= 480, `map too big: ${map.length}`);
  assert.match(map, /\+\d+ archivos más/);
});

test('buildRepoMapFromFiles: empty/no-source workspaces → empty string', async () => {
  assert.equal(await mapOf({}), '');
  assert.equal(await mapOf({ 'README.md': '# hola' }), '');
});

test('buildRepoMap: runner failure → empty string (never throws)', async () => {
  const out = await rm.buildRepoMap({
    runner: { exec: async () => { throw new Error('down'); } },
    project: 'p1',
  });
  assert.equal(out, '');
  assert.equal(await rm.buildRepoMap({}), '');
});

test('repo_map tool: returns the map as observation via the runner', async () => {
  const tool = buildTools.getTool('repo_map');
  const runner = {
    exec: async (_p, cmd) => {
      assert.equal(cmd[0], 'git');
      return { stdout: Object.keys(WORKSPACE).join('\n'), exitCode: 0 };
    },
    readFile: async (_p, path) => ({ content: WORKSPACE[path] ?? null }),
  };
  const out = await tool.execute({}, { runner, project: 'p1' });
  assert.equal(out.isError, false);
  assert.match(out.observation, /src\/App\.tsx/);
});

test('repo_map tool: degraded runner is informational, not an error', async () => {
  const tool = buildTools.getTool('repo_map');
  const out = await tool.execute({}, { runner: { exec: async () => { throw new Error('down'); } }, project: 'p1' });
  assert.equal(out.isError, false);
  assert.match(out.observation, /list_files/);
});
