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
//   - the batch route normalizes task.model with a plain default instead of
//     resolving through a locked tier function.
//
// These assertions pin the CURRENT contract so the lock cannot silently come
// back. They run in CI (not quarantined).

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

  it('BE-057 agent-batch normalizes each task model without a provider lock', () => {
    const src = read('routes/agent-batch.js');
    // Per-task optional string model with a plain default.
    assert.match(src, /body\('tasks\.\*\.model'\)\.optional\(\)\.isString\(\)/);
    assert.match(src, /model: task\.model \|\| 'gpt-4o'/);
  });
});
