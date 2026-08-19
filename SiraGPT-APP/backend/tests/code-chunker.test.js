/**
 * Unit tests for services/code-chunker.js.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  chunkCode,
  detectLanguage,
  extractTsJsNodes,
  extractPythonNodes,
  extractGoNodes,
  findBraceEnd,
  slidingWindowChunks,
} = require('../src/services/code-chunker');

// ─── language detection ─────────────────────────────────────────────────────

test('detectLanguage: from file extension', () => {
  assert.equal(detectLanguage('foo.ts', ''), 'typescript');
  assert.equal(detectLanguage('foo.tsx', ''), 'typescript');
  assert.equal(detectLanguage('foo.js', ''), 'javascript');
  assert.equal(detectLanguage('foo.py', ''), 'python');
  assert.equal(detectLanguage('foo.go', ''), 'go');
  assert.equal(detectLanguage('foo.rs', ''), 'rust');
  assert.equal(detectLanguage('foo.java', ''), 'java');
  assert.equal(detectLanguage('foo.cpp', ''), 'cpp');
  assert.equal(detectLanguage('foo.c', ''), 'c');
});

test('detectLanguage: content heuristic when extension missing', () => {
  assert.equal(detectLanguage('stdin', 'def foo():\n    return 1\n'), 'python');
  assert.equal(detectLanguage('stdin', 'package main\n\nfunc main() {}\n'), 'go');
  assert.equal(detectLanguage('stdin', 'fn main() { println!("hi"); }\n'), 'rust');
});

test('detectLanguage: unknown when nothing matches', () => {
  assert.equal(detectLanguage('foo.xyz', 'lorem ipsum'), 'unknown');
});

// ─── findBraceEnd ───────────────────────────────────────────────────────────

test('findBraceEnd: matches nested braces', () => {
  const lines = [
    'function foo() {',
    '  if (x) {',
    '    return { a: 1 };',
    '  }',
    '}',
    'const bar = 1;',
  ];
  assert.equal(findBraceEnd(lines, 0), 4);
});

test('findBraceEnd: ignores braces inside strings', () => {
  const lines = [
    'function foo() {',
    '  const s = "hello { world }";',
    '  return s;',
    '}',
  ];
  assert.equal(findBraceEnd(lines, 0), 3);
});

// ─── TS/JS extraction ───────────────────────────────────────────────────────

test('extractTsJsNodes: finds exported async function', () => {
  const src = `
import { x } from 'y';

export async function createUser(name: string): Promise<User> {
  return { name };
}
`;
  const nodes = extractTsJsNodes(src);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].name, 'createUser');
  assert.equal(nodes[0].nodeType, 'function');
  assert.equal(nodes[0].isExported, true);
  assert.equal(nodes[0].isAsync, true);
});

test('extractTsJsNodes: finds class and multiple functions', () => {
  const src = `
class User {
  constructor(name) { this.name = name; }
}

function helperOne() { return 1; }
function helperTwo() { return 2; }
`;
  const nodes = extractTsJsNodes(src);
  assert.equal(nodes.length, 3);
  assert.deepEqual(nodes.map(n => n.name), ['User', 'helperOne', 'helperTwo']);
  assert.equal(nodes[0].nodeType, 'class');
});

test('extractTsJsNodes: arrow function assigned to const', () => {
  const src = `export const compute = (x) => {
  return x * 2;
};`;
  const nodes = extractTsJsNodes(src);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].name, 'compute');
  assert.equal(nodes[0].isExported, true);
});

test('extractTsJsNodes: skips plain const assignments', () => {
  const src = `const PI = 3.14;
const NAMES = ['a', 'b'];
function realFn() { return 1; }`;
  const nodes = extractTsJsNodes(src);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].name, 'realFn');
});

// ─── Python extraction ──────────────────────────────────────────────────────

test('extractPythonNodes: finds top-level def and class', () => {
  const src = `import os

def foo():
    return 1

class Bar:
    def method(self):
        return 2

def baz():
    return 3
`;
  const nodes = extractPythonNodes(src);
  assert.equal(nodes.length, 3);
  assert.deepEqual(nodes.map(n => n.name), ['foo', 'Bar', 'baz']);
  assert.equal(nodes.find(n => n.name === 'Bar').nodeType, 'class');
  assert.equal(nodes.find(n => n.name === 'foo').nodeType, 'function');
});

test('extractPythonNodes: leading underscore marks non-exported', () => {
  const src = `def _private():
    return 1

def public():
    return 2
`;
  const nodes = extractPythonNodes(src);
  assert.equal(nodes.find(n => n.name === '_private').isExported, false);
  assert.equal(nodes.find(n => n.name === 'public').isExported, true);
});

test('extractPythonNodes: async def detected', () => {
  const src = `async def fetch():
    return 1
`;
  const nodes = extractPythonNodes(src);
  assert.equal(nodes[0].isAsync, true);
});

// ─── Go extraction ──────────────────────────────────────────────────────────

test('extractGoNodes: finds func and struct', () => {
  const src = `package main

type User struct {
    Name string
}

func (u *User) Greet() string {
    return "hi"
}

func main() {
    u := User{Name: "x"}
    u.Greet()
}
`;
  const nodes = extractGoNodes(src);
  assert.ok(nodes.length >= 3);
  assert.ok(nodes.some(n => n.name === 'User' && n.nodeType === 'struct'));
  assert.ok(nodes.some(n => n.name === 'Greet' && n.nodeType === 'function'));
  assert.ok(nodes.some(n => n.name === 'main' && n.nodeType === 'function'));
});

test('extractGoNodes: uppercase name → exported', () => {
  const src = `package p

func Public() {}
func private() {}
`;
  const nodes = extractGoNodes(src);
  assert.equal(nodes.find(n => n.name === 'Public').isExported, true);
  assert.equal(nodes.find(n => n.name === 'private').isExported, false);
});

// ─── slidingWindowChunks ────────────────────────────────────────────────────

test('slidingWindowChunks: fixed-size windows with overlap', () => {
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n');
  const chunks = slidingWindowChunks(lines, 'unknown.txt', 'unknown', { lineChunkSize: 60, lineOverlap: 10 });
  // step = 60 - 10 = 50 → 200/50 = 4 full windows, last one trimmed to file length
  assert.ok(chunks.length >= 4);
  assert.equal(chunks[0].startLine, 1);
  assert.equal(chunks[0].endLine, 60);
  // next starts at 1 + (60 - 10) = 51
  assert.equal(chunks[1].startLine, 51);
});

// ─── high-level chunkCode() ─────────────────────────────────────────────────

test('chunkCode: TS produces one chunk per function', () => {
  const src = `import x from 'y';

export function alpha() {
  return 1;
}

export function beta() {
  return 2;
}
`;
  const chunks = chunkCode('foo.ts', src);
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every(c => c.language === 'typescript'));
  assert.ok(chunks.every(c => c.nodeType === 'function'));
});

test('chunkCode: includes import block in each chunk when enabled', () => {
  const src = `import { fs } from 'fs';
import path from 'path';

export function readIt() {
  return fs.readFileSync('x');
}
`;
  const chunks = chunkCode('foo.ts', src, { includeImports: true });
  assert.ok(chunks[0].text.includes("import { fs }"));
  assert.ok(chunks[0].text.includes('readIt'));
});

test('chunkCode: unknown language falls back to sliding window', () => {
  const src = Array.from({ length: 90 }, (_, i) => `word ${i}`).join('\n');
  const chunks = chunkCode('foo.unknownext', src);
  assert.ok(chunks.length >= 1);
  assert.equal(chunks[0].nodeType, 'other');
});

test('chunkCode: skips chunks smaller than minLines', () => {
  const src = `function tiny() { return 1; }

function real() {
  const a = 1;
  const b = 2;
  return a + b;
}
`;
  const chunks = chunkCode('foo.js', src, { minLines: 3 });
  // tiny() is one line, real() is 5 lines → only real survives.
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].name, 'real');
});

test('chunkCode: returns [] on empty/invalid input', () => {
  assert.deepEqual(chunkCode('foo.ts', ''), []);
  assert.deepEqual(chunkCode('foo.ts', null), []);
});
