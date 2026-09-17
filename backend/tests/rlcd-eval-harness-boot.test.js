'use strict';

/**
 * Production boot must not crash when tests/fixtures are absent (Docker
 * images dockerignore backend/tests/). The Lenovo publish of a5c3b55f
 * (#725) rolled back because eval-harness.js top-level-required
 * document-rlcd-eval.json at import time of rlcd/index.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BACKEND = path.join(__dirname, '..');
const FIXTURE_NEEDLE = 'document-rlcd-eval.json';

function runIsolated(script) {
  return spawnSync(process.execPath, ['-e', script], {
    cwd: BACKEND,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_PATH: [path.join(BACKEND, 'node_modules'), process.env.NODE_PATH]
        .filter(Boolean)
        .join(path.delimiter),
    },
  });
}

function missingFixtureGuard() {
  return `
    const Module = require('node:module');
    const orig = Module._load;
    let fixtureLoads = 0;
    Module._load = function(request, parent, isMain) {
      if (String(request).includes(${JSON.stringify(FIXTURE_NEEDLE)})) {
        fixtureLoads += 1;
        const err = new Error("Cannot find module '" + request + "'");
        err.code = 'MODULE_NOT_FOUND';
        throw err;
      }
      return orig.apply(this, arguments);
    };
    globalThis.__rlcdFixtureLoads = () => fixtureLoads;
  `;
}

test('importing rlcd and eval-harness does not load the JSON fixture', () => {
  const script = `
    ${missingFixtureGuard()}
    const harness = require('./src/services/rlcd/eval-harness');
    const rlcd = require('./src/services/rlcd');
    process.stdout.write(JSON.stringify({
      fixtureLoads: globalThis.__rlcdFixtureLoads(),
      hasRunEval: typeof harness.runEval === 'function',
      hasRunDocumentEval: typeof rlcd.runDocumentEval === 'function',
    }));
  `;
  const result = runIsolated(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const out = JSON.parse(result.stdout);
  assert.equal(out.fixtureLoads, 0, 'import must not touch the fixture file');
  assert.equal(out.hasRunEval, true);
  assert.equal(out.hasRunDocumentEval, true);
});

test('runEval / runDocumentEval skip when the default fixture is missing', () => {
  const script = `
    ${missingFixtureGuard()}
    const harness = require('./src/services/rlcd/eval-harness');
    const rlcd = require('./src/services/rlcd');
    const afterImport = globalThis.__rlcdFixtureLoads();
    const report = harness.runEval();
    const facade = rlcd.runDocumentEval();
    process.stdout.write(JSON.stringify({
      afterImport,
      afterRun: globalThis.__rlcdFixtureLoads(),
      report,
      facade,
    }));
  `;
  const result = runIsolated(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const out = JSON.parse(result.stdout);
  assert.equal(out.afterImport, 0);
  assert.ok(out.afterRun >= 1, 'the fixture is only attempted inside runEval');
  assert.equal(out.report.skipped, true);
  assert.equal(out.report.reason, 'fixture_missing');
  assert.equal(out.report.n, 0);
  assert.equal(out.report.ok, false);
  assert.deepEqual(out.report.cases, []);
  assert.equal(out.facade.skipped, true);
  assert.equal(out.facade.n, 0);
});

test('runEval skips a missing path argument without throwing', () => {
  const harness = require('../src/services/rlcd/eval-harness');
  const missing = path.join(os.tmpdir(), `rlcd-eval-missing-${Date.now()}.json`);
  assert.equal(fs.existsSync(missing), false);
  const report = harness.runEval(missing);
  assert.equal(report.skipped, true);
  assert.equal(report.reason, 'fixture_missing');
  assert.equal(report.n, 0);
});

test('runEval still scores an in-memory fixture slice', () => {
  const prev = process.env.SIRAGPT_RLCD_DOCUMENTS;
  process.env.SIRAGPT_RLCD_DOCUMENTS = '1';
  try {
    const rlcd = require('../src/services/rlcd');
    const report = rlcd.runDocumentEval([
      {
        id: 'coding-turn-untouched',
        agent: 'coding',
        prompt: 'dame la web en local',
        files: [],
        answer: 'Preview listo en http://127.0.0.1:5173',
        expect: { unchanged: true, deferred: false, reason: 'not_document' },
      },
    ]);
    assert.equal(report.skipped, false);
    assert.equal(report.ok, true, JSON.stringify(report.cases));
    assert.equal(report.n, 1);
  } finally {
    if (prev == null) delete process.env.SIRAGPT_RLCD_DOCUMENTS;
    else process.env.SIRAGPT_RLCD_DOCUMENTS = prev;
  }
});
