'use strict';

const test = require('node:test');
const assert = require('node:assert');

const cli = require('../scripts/inspect-attribution');

test('parseArgs: --prompt extracted', () => {
  const r = cli.parseArgs(['node', 'script', '--prompt=hello world']);
  assert.strictEqual(r.prompt, 'hello world');
});

test('parseArgs: defaults', () => {
  const r = cli.parseArgs(['node', 'script']);
  assert.strictEqual(r.prompt, null);
  assert.strictEqual(r.json, false);
  assert.strictEqual(r.markdown, false);
  assert.strictEqual(r.visualize, null);
  assert.strictEqual(r.include, 'all');
  assert.strictEqual(r.tolerant, false);
});

test('parseArgs: --json flag', () => {
  const r = cli.parseArgs(['node', 'x', '--json']);
  assert.strictEqual(r.json, true);
});

test('parseArgs: --markdown flag', () => {
  const r = cli.parseArgs(['node', 'x', '--markdown']);
  assert.strictEqual(r.markdown, true);
});

test('parseArgs: --visualize=mermaid', () => {
  const r = cli.parseArgs(['node', 'x', '--visualize=mermaid']);
  assert.strictEqual(r.visualize, 'mermaid');
});

test('parseArgs: --include=a,b', () => {
  const r = cli.parseArgs(['node', 'x', '--include=a,b']);
  assert.strictEqual(r.include, 'a,b');
});

test('parseArgs: --tolerant', () => {
  const r = cli.parseArgs(['node', 'x', '--tolerant']);
  assert.strictEqual(r.tolerant, true);
});

test('parseArgs: --help flag', () => {
  const r = cli.parseArgs(['node', 'x', '--help']);
  assert.strictEqual(r.help, true);
});

test('parseArgs: -h short alias', () => {
  const r = cli.parseArgs(['node', 'x', '-h']);
  assert.strictEqual(r.help, true);
});

test('parseArgs: unknown flags are ignored', () => {
  const r = cli.parseArgs(['node', 'x', '--zzz', '--prompt=p']);
  assert.strictEqual(r.prompt, 'p');
});

test('safeRun: success path returns ok=true with value', () => {
  const r = cli.safeRun('test', () => 42, true);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value, 42);
});

test('safeRun: throwing fn returns ok=false when tolerant', () => {
  const r = cli.safeRun('test', () => { throw new Error('boom'); }, true);
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes('boom'));
});

test('safeRun: throwing fn rethrows when not tolerant', () => {
  assert.throws(() => cli.safeRun('test', () => { throw new Error('boom'); }, false));
});

test('parseArgs: --prompt with equals + spaces', () => {
  const r = cli.parseArgs(['node', 'x', '--prompt=hello world with = sign']);
  assert.strictEqual(r.prompt, 'hello world with = sign');
});
