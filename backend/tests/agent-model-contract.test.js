'use strict';

// BE-050 / BE-056 / BE-057 — model-contract specs, reconciled with PR #308.
//
// The ola-200 wave D/E versions of these specs encoded the old
// "DeepSeek-locked" decision that #308 explicitly rejected: the agent model
// is no longer hard-wired to native DeepSeek. Current contract:
//   - the caller selects the model per request (validated as an optional
//     string, never a fixed provider constant);
//   - provider-specific clients are selected per-request (Gemini /
//     OpenRouter / DeepSeek / OpenAI), so a single-provider lock assertion
//     would be wrong on purpose;
//   - the batch route keeps the validation layer provider-agnostic
//     (`tasks.*.model` is a free optional string). Tiering of task models is
//     owned by #308's `resolveBatchModel`, which lives on production-main
//     and survives any merge of this branch (this branch never touched
//     routes/agent-batch.js); asserting its internals here would re-couple
//     this contract test to a decision that belongs to #308.
//
// These assertions pin the CURRENT contract. They run in CI (not quarantined).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '../src');

function read(rel) {
  return fs.readFileSync(path.join(SRC, rel), 'utf8');
}

describe('BE-050/056/057 model contract (post-#308 reconciliation)', () => {
  it('BE-050 generate-word accepts caller-selected provider/model per request', () => {
    const src = read('routes/generate-document.js');
    // Model + provider are required, validated inputs — not constants.
    assert.match(src, /body\('model'\)\.trim\(\)\.notEmpty\(\)/);
    assert.match(src, /body\('provider'\)\.trim\(\)\.notEmpty\(\)/);
    // Per-request provider client selection: all four providers reachable.
    for (const marker of [
      'provider === "Gemini"',
      'provider === "OpenRouter"',
      'provider === "DeepSeek"',
      'apiKey: process.env.OPENAI_API_KEY',
    ]) {
      assert.ok(src.includes(marker), `expected ${marker} in routes/generate-document.js`);
    }
  });

  it('BE-056 agent run passes the caller-selected model to the executor', () => {
    const src = read('routes/agent.js');
    // Model stays caller-controlled: optional string input, forwarded as-is.
    assert.match(src, /body\('model'\)\.optional\(\)\.isString\(\)/);
    assert.match(src, /executorModel: req\.body\.model \|\| 'gpt-4o'/);
  });

  it('BE-057 agent-batch keeps task models provider-agnostic at validation', () => {
    const src = read('routes/agent-batch.js');
    // Per-task model stays a free optional string at the validation layer —
    // the batch route is not provider-locked on input. Tiering of accepted
    // values is #308's resolveBatchModel (asserted in
    // tests/agent-batch-model-tiering.test.js), not this contract's concern.
    assert.match(src, /body\('tasks\.\*\.model'\)\.optional\(\)\.isString\(\)/);
  });
});
