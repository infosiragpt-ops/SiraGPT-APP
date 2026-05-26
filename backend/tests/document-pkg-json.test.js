'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-pkg-json');
const { extractPkgJson, buildPkgJsonForFiles, renderPkgJsonBlock, _internal } = engine;
const { isPkgJsonLike, commandHead } = _internal;

const PKG_FIXTURE = `{
  "name": "my-app",
  "version": "1.2.3",
  "description": "An example application",
  "license": "MIT",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "packageManager": "pnpm@8.6.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "test": "vitest run",
    "lint": "eslint . --max-warnings 0",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "next": "^14.0.0",
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "@radix-ui/react-dialog": "^1.0.0",
    "zod": "^3.22.0"
  },
  "devDependencies": {
    "vitest": "^1.0.0",
    "eslint": "^8.0.0",
    "typescript": "^5.0.0"
  },
  "peerDependencies": {
    "react": ">=18"
  },
  "engines": {
    "node": ">=20",
    "pnpm": ">=8"
  },
  "workspaces": ["packages/*", "apps/*"]
}`;

test('empty / non-string tolerated', () => {
  assert.equal(extractPkgJson('').total, 0);
  assert.equal(extractPkgJson(null).total, 0);
});

test('non-package.json text returns empty', () => {
  const r = extractPkgJson('Just regular text without package.json structure');
  assert.equal(r.total, 0);
});

test('isPkgJsonLike heuristic', () => {
  assert.ok(isPkgJsonLike('{"name": "x"}'));
  assert.ok(isPkgJsonLike('{"scripts": {}}'));
  assert.ok(!isPkgJsonLike('plain text'));
});

test('commandHead extracts first word', () => {
  assert.equal(commandHead('next dev'), 'next');
  assert.equal(commandHead('tsc --noEmit'), 'tsc');
  assert.equal(commandHead(''), '');
});

test('detects meta fields (name, version, license)', () => {
  const r = extractPkgJson(PKG_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'meta' && e.name === 'name' && e.detail === 'my-app'));
  assert.ok(r.entries.some((e) => e.kind === 'meta' && e.name === 'version' && e.detail === '1.2.3'));
  assert.ok(r.entries.some((e) => e.kind === 'meta' && e.name === 'license' && e.detail === 'MIT'));
});

test('detects packageManager / private / type', () => {
  const r = extractPkgJson(PKG_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'meta' && e.name === 'packageManager'));
  assert.ok(r.entries.some((e) => e.kind === 'meta' && e.name === 'private'));
  assert.ok(r.entries.some((e) => e.kind === 'meta' && e.name === 'type'));
});

test('detects scripts', () => {
  const r = extractPkgJson(PKG_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'script' && e.name === 'dev' && e.detail === 'next'));
  assert.ok(r.entries.some((e) => e.kind === 'script' && e.name === 'build'));
  assert.ok(r.entries.some((e) => e.kind === 'script' && e.name === 'test'));
});

test('script body is masked to first command head', () => {
  const r = extractPkgJson(PKG_FIXTURE);
  const lint = r.entries.find((e) => e.kind === 'script' && e.name === 'lint');
  assert.ok(lint);
  assert.equal(lint.detail, 'eslint');
  // Should not include "--max-warnings"
  assert.ok(!/max-warnings/.test(lint.detail));
});

test('detects dependencies with version', () => {
  const r = extractPkgJson(PKG_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'dependencies' && e.name === 'next'));
  assert.ok(r.entries.some((e) => e.kind === 'dependencies' && e.name === 'react'));
});

test('detects devDependencies', () => {
  const r = extractPkgJson(PKG_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'devDependencies' && e.name === 'vitest'));
  assert.ok(r.entries.some((e) => e.kind === 'devDependencies' && e.name === 'typescript'));
});

test('detects peerDependencies', () => {
  const r = extractPkgJson(PKG_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'peerDependencies' && e.name === 'react'));
});

test('detects scoped packages (@org/pkg)', () => {
  const r = extractPkgJson(PKG_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'dependencies' && /^@radix-ui/.test(e.name)));
});

test('detects engines', () => {
  const r = extractPkgJson(PKG_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'engine' && e.name === 'node' && e.detail === '>=20'));
  assert.ok(r.entries.some((e) => e.kind === 'engine' && e.name === 'pnpm'));
});

test('detects workspaces', () => {
  const r = extractPkgJson(PKG_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'workspace' && e.name === 'packages/*'));
  assert.ok(r.entries.some((e) => e.kind === 'workspace' && e.name === 'apps/*'));
});

test('totals count all deps even if not enumerated', () => {
  const r = extractPkgJson(PKG_FIXTURE);
  // 5 deps, 3 devDeps, 1 peerDep
  assert.ok(r.totals.dependencies >= 5);
  assert.ok(r.totals.devDependencies >= 3);
  assert.ok(r.totals.peerDependencies >= 1);
});

test('caps entries per file', () => {
  let text = '{"name": "x", "scripts": {';
  for (let i = 0; i < 30; i++) text += `"s${i}": "echo ${i}",`;
  text = text.slice(0, -1) + '}}';
  const r = extractPkgJson(text);
  assert.ok(r.entries.length <= 24);
});

test('counts totals by kind', () => {
  const r = extractPkgJson(PKG_FIXTURE);
  assert.ok(r.totals.script >= 4);
});

test('buildPkgJsonForFiles aggregates across batch', () => {
  const files = [
    { name: 'pkg-a.json', extractedText: '{"name": "a", "version": "1.0.0"}' },
    { name: 'pkg-b.json', extractedText: '{"name": "b", "scripts": {"x": "y"}}' },
  ];
  const r = buildPkgJsonForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderPkgJsonBlock returns markdown when entries exist', () => {
  const files = [{ name: 'package.json', extractedText: PKG_FIXTURE }];
  const r = buildPkgJsonForFiles(files);
  const md = renderPkgJsonBlock(r);
  assert.match(md, /^## PACKAGE\.JSON/);
});

test('renderPkgJsonBlock empty when nothing surfaces', () => {
  assert.equal(renderPkgJsonBlock({ perFile: [] }), '');
  assert.equal(renderPkgJsonBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildPkgJsonForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: PKG_FIXTURE },
  ]);
  assert.equal(r.perFile.length, 1);
});
