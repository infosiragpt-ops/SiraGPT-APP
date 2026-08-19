/**
 * Tests for i18n/cli.js — message-audit CLI entrypoint.
 *
 * The module only exports main(). We mock ./audit via require-cache
 * injection so we can verify the wiring between argv parsing, audit
 * invocation, and stdout/exit-code behavior — without touching the
 * filesystem.
 */

'use strict';

const assert = require('node:assert');
const Module = require('node:module');
const path = require('node:path');
const { describe, it, before, beforeEach, after } = require('node:test');

const AUDIT_PATH = require.resolve('../src/i18n/audit');
const CLI_PATH = require.resolve('../src/i18n/cli');

// State auditI18n captures so each test can assert on the args.
let lastAuditCall = null;
let nextAuditResult = { missing: [], unused: [], byLocale: {} };

const auditMock = {
  auditI18n: (opts) => {
    lastAuditCall = opts;
    return nextAuditResult;
  },
  formatReport: (report) => `TEXT-REPORT missing=${report.missing.length} unused=${report.unused.length}`,
};

let origAuditCache;
let origCliCache;

function installMocks() {
  origAuditCache = require.cache[AUDIT_PATH];
  origCliCache = require.cache[CLI_PATH];

  const m = new Module(AUDIT_PATH);
  m.filename = AUDIT_PATH;
  m.loaded = true;
  m.exports = auditMock;
  m.paths = Module._nodeModulePaths(path.dirname(AUDIT_PATH));
  require.cache[AUDIT_PATH] = m;
  delete require.cache[CLI_PATH];
}

function restoreMocks() {
  if (origAuditCache) require.cache[AUDIT_PATH] = origAuditCache;
  else delete require.cache[AUDIT_PATH];
  if (origCliCache) require.cache[CLI_PATH] = origCliCache;
  else delete require.cache[CLI_PATH];
}

let cli;

before(() => {
  installMocks();
  cli = require('../src/i18n/cli');
});

after(() => {
  restoreMocks();
});

// Capture stdout writes per-test.
const _origWrite = process.stdout.write.bind(process.stdout);
function captureStdout(fn) {
  const chunks = [];
  process.stdout.write = (chunk) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return true;
  };
  try {
    const code = fn();
    return { code, out: chunks.join('') };
  } finally {
    process.stdout.write = _origWrite;
  }
}

beforeEach(() => {
  lastAuditCall = null;
  nextAuditResult = { missing: [], unused: [], byLocale: {} };
});

function runMain(argv) {
  const prev = process.argv;
  process.argv = ['node', 'cli.js', ...argv];
  try {
    return captureStdout(() => cli.main());
  } finally {
    process.argv = prev;
  }
}

describe('cli · help', () => {
  it('prints usage and exits 0 with --help', () => {
    const { code, out } = runMain(['--help']);
    assert.equal(code, 0);
    assert.match(out, /Usage: node backend\/src\/i18n\/cli\.js/);
    assert.match(out, /--messages <dir>/);
    assert.match(out, /--code <dir>/);
    assert.match(out, /--base <locale>/);
    assert.match(out, /--json/);
    assert.match(out, /--strict/);
  });

  it('also accepts the -h short form', () => {
    const { code, out } = runMain(['-h']);
    assert.equal(code, 0);
    assert.match(out, /Usage:/);
  });

  it('--help short-circuits before audit is invoked', () => {
    runMain(['--help']);
    assert.equal(lastAuditCall, null, 'audit should NOT run when --help is set');
  });
});

describe('cli · default audit invocation', () => {
  it('runs with default messages/ and base="en" when no flags', () => {
    const { code } = runMain([]);
    assert.equal(code, 0);
    assert.ok(lastAuditCall, 'audit must be called');
    assert.equal(lastAuditCall.baseLocale, 'en');
    assert.equal(path.basename(lastAuditCall.messagesDir), 'messages');
    // Defaults to [app, components] when no --code flag.
    assert.equal(lastAuditCall.codeDirs.length, 2);
    assert.ok(lastAuditCall.codeDirs[0].endsWith('app'));
    assert.ok(lastAuditCall.codeDirs[1].endsWith('components'));
  });

  it('text report is the default output format', () => {
    const { out } = runMain([]);
    assert.match(out, /TEXT-REPORT missing=0 unused=0/);
  });
});

describe('cli · argument parsing', () => {
  it('--messages overrides the messages directory', () => {
    runMain(['--messages', '/custom/messages']);
    assert.equal(lastAuditCall.messagesDir, '/custom/messages');
  });

  it('--base overrides the base locale', () => {
    runMain(['--base', 'es']);
    assert.equal(lastAuditCall.baseLocale, 'es');
  });

  it('--code can be repeated, replacing the default [app, components]', () => {
    runMain(['--code', '/a/lib', '--code', '/b/pages']);
    assert.deepEqual(lastAuditCall.codeDirs, ['/a/lib', '/b/pages']);
  });

  it('--json emits JSON instead of text', () => {
    nextAuditResult = { missing: ['x.y'], unused: ['z'], byLocale: { en: 1 } };
    const { out } = runMain(['--json']);
    // JSON.parse must succeed.
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed, nextAuditResult);
  });
});

describe('cli · --strict exit code', () => {
  it('returns 0 when --strict and there are no findings', () => {
    nextAuditResult = { missing: [], unused: [], byLocale: {} };
    const { code } = runMain(['--strict']);
    assert.equal(code, 0);
  });

  it('returns 1 when --strict and there are missing keys', () => {
    nextAuditResult = { missing: ['hello.world'], unused: [], byLocale: {} };
    const { code } = runMain(['--strict']);
    assert.equal(code, 1);
  });

  it('returns 1 when --strict and there are unused keys', () => {
    nextAuditResult = { missing: [], unused: ['orphan.key'], byLocale: {} };
    const { code } = runMain(['--strict']);
    assert.equal(code, 1);
  });

  it('without --strict, findings do NOT change the exit code', () => {
    nextAuditResult = { missing: ['a', 'b'], unused: ['c'], byLocale: {} };
    const { code } = runMain([]);
    assert.equal(code, 0);
  });
});

describe('cli · module exports', () => {
  it('exports exactly { main }', () => {
    assert.deepEqual(Object.keys(cli), ['main']);
    assert.equal(typeof cli.main, 'function');
  });
});
