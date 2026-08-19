'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-vitest');
const { extractVitest, buildVitestForFiles, renderVitestBlock, _internal } = engine;
const { detectFramework } = _internal;

const VITEST_FIXTURE = `import { describe, test, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('User service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('createUser returns ID', () => {
    const result = createUser({ name: 'Alice' });
    expect(result).toBe(42);
    expect(result).toEqual(42);
    expect(result).toBeTruthy();
  });

  it.skip('handles missing fields', () => {
    expect(() => createUser({})).toThrow();
  });

  test.each([[1, 2], [3, 4]])('adds %i + %i', (a, b) => {
    expect(a + b).toBeGreaterThan(0);
  });

  it('resolves async', async () => {
    await expect(fetchUser(1)).resolves.toEqual({ id: 1 });
  });

  it('rejects on error', async () => {
    await expect(fetchUser(-1)).rejects.toThrow('Invalid ID');
  });

  it('uses mocks', () => {
    const mock = vi.fn(() => 'mocked');
    vi.spyOn(console, 'log');
    expect(mock()).toBe('mocked');
  });

  it('matches snapshot', () => {
    expect({ a: 1 }).toMatchSnapshot();
    expect('hello').toMatchInlineSnapshot('"hello"');
  });
});`;

const JEST_FIXTURE = `import { jest } from '@jest/globals';

describe('Auth', () => {
  beforeAll(() => {
    jest.useFakeTimers();
  });

  it('logs in', () => {
    const spy = jest.fn();
    expect(spy).toHaveBeenCalled();
  });
});`;

test('empty / non-string tolerated', () => {
  assert.equal(extractVitest('').total, 0);
  assert.equal(extractVitest(null).total, 0);
});

test('non-test text returns empty', () => {
  const r = extractVitest('Just regular code without test or expect');
  assert.equal(r.total, 0);
});

test('detectFramework: vitest / jest / null', () => {
  assert.equal(detectFramework('import { vi } from "vitest"; vi.fn();'), 'vitest');
  assert.equal(detectFramework('import { jest } from "@jest/globals"; jest.fn();'), 'jest');
  assert.equal(detectFramework('plain text'), null);
});

test('detects framework: vitest', () => {
  const r = extractVitest(VITEST_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'framework' && e.name === 'vitest'));
});

test('detects framework: jest', () => {
  const r = extractVitest(JEST_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'framework' && e.name === 'jest'));
});

test('detects test runners describe/test/it', () => {
  const r = extractVitest(VITEST_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'runner' && e.name === 'describe'));
  assert.ok(r.entries.some((e) => e.kind === 'runner' && e.name === 'test'));
  assert.ok(r.entries.some((e) => e.kind === 'runner' && e.name === 'it'));
});

test('detects test modifiers .skip / .each', () => {
  const r = extractVitest(VITEST_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'runner' && e.name === 'it.skip'));
  assert.ok(r.entries.some((e) => e.kind === 'runner' && e.name === 'test.each'));
});

test('detects lifecycle beforeEach/afterEach/beforeAll', () => {
  const r = extractVitest(VITEST_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'lifecycle' && e.name === 'beforeEach'));
  const r2 = extractVitest(JEST_FIXTURE);
  assert.ok(r2.entries.some((e) => e.kind === 'lifecycle' && e.name === 'beforeAll'));
});

test('counts expect() calls', () => {
  const r = extractVitest(VITEST_FIXTURE);
  assert.ok(r.totals.expect >= 5);
});

test('detects matchers toBe/toEqual/toThrow', () => {
  const r = extractVitest(VITEST_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'matcher' && e.name === 'toBe'));
  assert.ok(r.entries.some((e) => e.kind === 'matcher' && e.name === 'toEqual'));
  assert.ok(r.entries.some((e) => e.kind === 'matcher' && e.name === 'toThrow'));
});

test('detects toBeTruthy/toBeGreaterThan/toHaveBeenCalled', () => {
  const r = extractVitest(VITEST_FIXTURE);
  assert.ok(r.entries.some((e) => e.name === 'toBeTruthy'));
  assert.ok(r.entries.some((e) => e.name === 'toBeGreaterThan'));
  const r2 = extractVitest(JEST_FIXTURE);
  assert.ok(r2.entries.some((e) => e.name === 'toHaveBeenCalled'));
});

test('detects resolves.toEqual / rejects.toThrow', () => {
  const r = extractVitest(VITEST_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'negation'));
});

test('detects vi.fn / vi.spyOn / vi.clearAllMocks', () => {
  const r = extractVitest(VITEST_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'mock' && e.name === 'fn'));
  assert.ok(r.entries.some((e) => e.kind === 'mock' && e.name === 'spyOn'));
});

test('detects jest.fn / jest.useFakeTimers', () => {
  const r = extractVitest(JEST_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'mock' && e.name === 'fn'));
  assert.ok(r.entries.some((e) => e.kind === 'mock' && e.name === 'useFakeTimers'));
});

test('detects toMatchSnapshot / toMatchInlineSnapshot', () => {
  const r = extractVitest(VITEST_FIXTURE);
  assert.ok(r.totals.snapshot >= 1);
});

test('dedupes identical runner entries', () => {
  const r = extractVitest('describe("a", () => {}); describe("a", () => {});');
  assert.equal(r.entries.filter((e) => e.kind === 'runner' && e.detail === 'a').length, 1);
});

test('caps entries per file', () => {
  let text = 'import {vi} from "vitest"; ';
  for (let i = 0; i < 40; i++) text += `test("t${i}", () => { expect(${i}).toBe(${i}); }); `;
  const r = extractVitest(text);
  assert.ok(r.entries.length <= 24);
});

test('counts totals by kind', () => {
  const r = extractVitest(VITEST_FIXTURE);
  assert.ok(r.totals.runner >= 3);
  assert.ok(r.totals.matcher >= 3);
});

test('buildVitestForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.test.ts', extractedText: VITEST_FIXTURE },
    { name: 'b.test.ts', extractedText: JEST_FIXTURE },
  ];
  const r = buildVitestForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderVitestBlock returns markdown when entries exist', () => {
  const files = [{ name: 'user.test.ts', extractedText: VITEST_FIXTURE }];
  const r = buildVitestForFiles(files);
  const md = renderVitestBlock(r);
  assert.match(md, /^## VITEST/);
});

test('renderVitestBlock empty when nothing surfaces', () => {
  assert.equal(renderVitestBlock({ perFile: [] }), '');
  assert.equal(renderVitestBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildVitestForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: VITEST_FIXTURE },
  ]);
  assert.equal(r.perFile.length, 1);
});
