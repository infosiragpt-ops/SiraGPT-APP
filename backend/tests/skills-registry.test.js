/**
 * skills registry loader tests.
 *
 * We test against a temp fixture dir (not the real backend/src/skills)
 * so the suite is hermetic: renaming or removing a bundled skill
 * shouldn't break these tests, and these tests shouldn't leak partial
 * skill state into the default registry cache.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const registry = require('../src/services/skills/registry');
const { CAPABILITIES } = require('../src/services/skills/capabilities');
const { capabilities } = require('../src/services/skills');

function mkFixture(spec) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  for (const [skillId, { manifest, handler }] of Object.entries(spec)) {
    const sdir = path.join(dir, skillId);
    fs.mkdirSync(sdir, { recursive: true });
    if (manifest !== undefined) {
      fs.writeFileSync(path.join(sdir, 'manifest.json'),
        typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2));
    }
    if (handler !== undefined) {
      fs.writeFileSync(path.join(sdir, 'handler.js'), handler);
    }
  }
  return dir;
}

function validManifest(overrides = {}) {
  return {
    id: overrides.id || 'echo',
    name: 'Echo',
    version: '1.0.0',
    description: 'Echo back its args for testing.',
    capabilities: [CAPABILITIES.LLM],
    params: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
    ...overrides,
  };
}

const validHandler = `module.exports = { execute: async (args) => ({ echoed: args }) };`;

test('loads a valid skill from disk', async () => {
  const dir = mkFixture({
    echo: { manifest: validManifest(), handler: validHandler },
  });
  const { skills, errors } = registry.load({ dir });
  assert.equal(errors.length, 0, `expected no errors, got: ${errors.join('; ')}`);
  assert.equal(skills.size, 1);
  const echo = skills.get('echo');
  assert.equal(echo.id, 'echo');
  assert.deepEqual(echo.capabilities, [CAPABILITIES.LLM]);
  const out = await echo.execute({ x: 'hi' }, {});
  assert.deepEqual(out, { echoed: { x: 'hi' } });
});

test('skips folders without manifest+handler, errors on broken ones', () => {
  const dir = mkFixture({
    no_handler: { manifest: validManifest({ id: 'no_handler' }) },
    bad_json: { manifest: '{ not json }', handler: validHandler },
    good: { manifest: validManifest({ id: 'good' }), handler: validHandler },
  });
  // also create a folder with neither file — should be silently ignored
  fs.mkdirSync(path.join(dir, 'empty_dir'));

  const { skills, errors } = registry.load({ dir });
  assert.equal(skills.size, 1);
  assert.ok(skills.has('good'));
  assert.equal(errors.length, 1, `expected 1 error (bad_json), got ${errors.length}: ${errors.join(' | ')}`);
  assert.match(errors[0], /bad_json.*not valid JSON/);
});

test('rejects manifest with unknown capability', () => {
  const dir = mkFixture({
    nope: {
      manifest: validManifest({ id: 'nope', capabilities: ['totally-made-up'] }),
      handler: validHandler,
    },
  });
  const { skills, errors } = registry.load({ dir });
  assert.equal(skills.size, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unknown capability/);
});

test('rejects manifest with invalid id pattern', () => {
  const dir = mkFixture({
    Bad_Name: { manifest: validManifest({ id: 'Bad_Name' }), handler: validHandler },
  });
  const { skills, errors } = registry.load({ dir });
  assert.equal(skills.size, 0);
  assert.match(errors[0], /must match/);
});

test('detects duplicate ids across folders', () => {
  // Two folders each declaring id "dup" should yield one loaded + one error
  const dir = mkFixture({
    a: { manifest: validManifest({ id: 'dup' }), handler: validHandler },
    b: { manifest: validManifest({ id: 'dup' }), handler: validHandler },
  });
  const { skills, errors } = registry.load({ dir });
  assert.equal(skills.size, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /duplicate skill id "dup"/);
});

test('toReactTool adapter preserves contract', async () => {
  const dir = mkFixture({ echo: { manifest: validManifest(), handler: validHandler } });
  const { skills } = registry.load({ dir });
  const tool = registry.toReactTool(skills.get('echo'));
  assert.equal(tool.name, 'echo');
  assert.equal(tool.description, 'Echo back its args for testing.');
  assert.equal(tool.parameters.type, 'object');
  const out = await tool.execute({ x: 'ok' }, {});
  assert.deepEqual(out, { echoed: { x: 'ok' } });
});

test('toAgentCoreTool adapter produces readable schema hints', () => {
  const dir = mkFixture({
    echo: {
      manifest: validManifest({
        params: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'what to search' },
            k: { type: 'integer', enum: [1, 2, 3] },
          },
          required: ['query'],
        },
      }),
      handler: validHandler,
    },
  });
  const { skills } = registry.load({ dir });
  const tool = registry.toAgentCoreTool(skills.get('echo'));
  assert.equal(tool.name, 'echo');
  assert.ok(typeof tool.handler === 'function');
  assert.match(tool.schema.query, /string \(required\).*what to search/);
  assert.match(tool.schema.k, /integer \(optional\).*one of: 1, 2, 3/);
});

test('filterByCapabilities returns only skills whose caps ⊆ allow', () => {
  const dir = mkFixture({
    pure: {
      manifest: validManifest({ id: 'pure', capabilities: [CAPABILITIES.LLM] }),
      handler: validHandler,
    },
    net: {
      manifest: validManifest({ id: 'net', capabilities: [CAPABILITIES.LLM, CAPABILITIES.NET_OUTBOUND] }),
      handler: validHandler,
    },
  });
  const { skills } = registry.load({ dir });
  const allowed = registry.filterByCapabilities(skills, [CAPABILITIES.LLM]);
  assert.equal(allowed.size, 1);
  assert.ok(allowed.has('pure'));
  assert.ok(!allowed.has('net'));
});

test('capabilities.assertKnown catches typos at validation time', () => {
  assert.throws(() => capabilities.assertKnown(['made:up'], 'test'), /unknown capability/);
  assert.doesNotThrow(() => capabilities.assertKnown([CAPABILITIES.LLM, CAPABILITIES.FS_READ], 'test'));
});

test('manifest with timeoutMs accepts valid integer in [100, 600000]', () => {
  const dir = mkFixture({
    bounded: {
      manifest: validManifest({ id: 'bounded', timeoutMs: 5_000 }),
      handler: validHandler,
    },
  });
  const { skills, errors } = registry.load({ dir });
  assert.equal(errors.length, 0, `expected no errors, got: ${errors.join('; ')}`);
  assert.ok(skills.has('bounded'));
  assert.equal(skills.get('bounded').timeoutMs, 5_000);
});

test('manifest with out-of-range timeoutMs is rejected loudly', () => {
  const dir = mkFixture({
    too_long: {
      manifest: validManifest({ id: 'too_long', timeoutMs: 999_999 }),
      handler: validHandler,
    },
  });
  const { skills, errors } = registry.load({ dir });
  assert.equal(skills.size, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /timeoutMs.*\[100, 600000\]/);
});

test('manifest with non-integer timeoutMs is rejected', () => {
  const dir = mkFixture({
    fractional: {
      manifest: validManifest({ id: 'fractional', timeoutMs: 5.5 }),
      handler: validHandler,
    },
  });
  const { skills, errors } = registry.load({ dir });
  assert.equal(skills.size, 0);
  assert.match(errors[0], /timeoutMs/);
});

test('bundled skills load cleanly from the real skills dir', () => {
  // Smoke test: every bundled skill in backend/src/skills/ should
  // load without errors. New skills should be added to the assertion
  // list below so an accidentally broken manifest fails CI here
  // before it ever runs in production.
  const { skills, errors } = registry.load();
  assert.equal(errors.length, 0, `bundled skills should load clean: ${errors.join(' | ')}`);
  // Original three (Pattern 1):
  assert.ok(skills.has('web_search'), 'web_search should be bundled');
  assert.ok(skills.has('rag_retrieve'), 'rag_retrieve should be bundled');
  assert.ok(skills.has('read_file'), 'read_file should be bundled');
  // Scheduling primitives (Pattern 4):
  assert.ok(skills.has('cron_schedule'), 'cron_schedule should be bundled');
  assert.ok(skills.has('cron_list'), 'cron_list should be bundled');
  assert.ok(skills.has('cron_cancel'), 'cron_cancel should be bundled');
  assert.ok(skills.has('webhook_create'), 'webhook_create should be bundled');
  // Sessions-as-tools (Pattern 5):
  assert.ok(skills.has('session_list'), 'session_list should be bundled');
  assert.ok(skills.has('session_history'), 'session_history should be bundled');
  assert.ok(skills.has('session_search'), 'session_search should be bundled');
  assert.ok(skills.has('session_spawn'), 'session_spawn should be bundled');
  assert.ok(skills.has('session_send'), 'session_send should be bundled');
  // Academic skills (Followup C):
  assert.ok(skills.has('openalex_search'), 'openalex_search should be bundled');
  assert.ok(skills.has('crossref_verify'), 'crossref_verify should be bundled');
  assert.ok(skills.has('apa7_format'), 'apa7_format should be bundled');
  // OpenClaw-inspired capabilities rewritten as native SiraGPT skills:
  assert.ok(skills.has('summarize'), 'summarize should be bundled');
  assert.ok(skills.has('weather'), 'weather should be bundled');
  assert.ok(skills.has('audio_transcribe'), 'audio_transcribe should be bundled');
  assert.ok(skills.has('audio_spectrogram'), 'audio_spectrogram should be bundled');
  assert.ok(skills.has('video_frames'), 'video_frames should be bundled');
  assert.ok(skills.has('task_flow_create'), 'task_flow_create should be bundled');
  assert.ok(skills.has('task_flow_list'), 'task_flow_list should be bundled');
  assert.ok(skills.has('task_flow_get'), 'task_flow_get should be bundled');
  assert.ok(skills.has('task_flow_update'), 'task_flow_update should be bundled');
});
