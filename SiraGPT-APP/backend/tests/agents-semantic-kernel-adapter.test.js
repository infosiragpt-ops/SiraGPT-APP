/**
 * Tests for services/agents/semantic-kernel-adapter.js — Semantic
 * Kernel compatible plugin/agent/memory adapter.
 */

'use strict';

const assert = require('node:assert');
const { describe, it, beforeEach } = require('node:test');

const {
  createSemanticKernelAdapter,
} = require('../src/services/agents/semantic-kernel-adapter');

let sk;

beforeEach(() => {
  sk = createSemanticKernelAdapter();
});

// ── factory + capabilities ─────────────────────────────────────

describe('createSemanticKernelAdapter · factory', () => {
  it('returns an object with the documented public API', () => {
    const a = createSemanticKernelAdapter();
    for (const k of ['vendor', 'registerPlugin', 'invoke', 'createAgent', 'runAgent', 'listPlugins', 'memory', 'capabilities']) {
      assert.ok(k in a, `expected key ${k}`);
    }
  });

  it('vendor is the compatibility marker (no official JS SDK)', () => {
    assert.equal(sk.vendor, 'semantic-kernel-compatible');
    assert.equal(sk.officialSdkRuntime, 'csharp-python-java-bridge');
  });

  it('capabilities() reports the supported feature set', () => {
    const caps = sk.capabilities();
    assert.equal(caps.plugins, true);
    assert.equal(caps.memory, true);
    assert.equal(caps.multi_agent, true);
    assert.equal(caps.official_javascript_sdk, false);
    assert.deepEqual(caps.official_supported_languages.sort(), ['csharp', 'java', 'python']);
  });
});

// ── registerPlugin ─────────────────────────────────────────────

describe('registerPlugin', () => {
  it('throws when pluginName is missing', () => {
    assert.throws(() => sk.registerPlugin('', { f: () => null }), /pluginName required/);
    assert.throws(() => sk.registerPlugin(null, { f: () => null }), /pluginName required/);
  });

  it('throws when functions object is empty', () => {
    assert.throws(() => sk.registerPlugin('Math', {}), /functions required/);
  });

  it('accepts a bare function as the descriptor', () => {
    const out = sk.registerPlugin('Math', { add: (a) => a + 1 });
    assert.deepEqual(out, { plugin: 'math', functionCount: 1 });
  });

  it('accepts a { invoke, description, schema } descriptor object', () => {
    const out = sk.registerPlugin('Math', {
      add: { invoke: (x) => x + 1, description: 'adds 1', schema: { type: 'number' } },
    });
    assert.equal(out.functionCount, 1);
  });

  it('normalizes plugin and function names (lowercase, _ for invalid chars)', () => {
    sk.registerPlugin('MyPlugin Name!', { 'FuncName2$': () => null });
    const plugins = sk.listPlugins();
    assert.equal(plugins[0].name, 'myplugin_name_');
    assert.equal(plugins[0].functions[0], 'funcname2_');
  });

  it('throws on invalid function (no invoke + not a function)', () => {
    assert.throws(
      () => sk.registerPlugin('Math', { broken: { description: 'no invoke' } }),
      /invalid function "broken"/,
    );
  });

  it('normalizes punctuation-only function names to "_" rather than rejecting', () => {
    // normalizeName('!!!') → '_' (single underscore). Not empty, so the
    // function is registered under the normalized name. Pin actual
    // behavior so a stricter validator surfaces here intentionally.
    const out = sk.registerPlugin('Math', { '!!!': () => 'ok' });
    assert.equal(out.functionCount, 1);
    const plugin = sk.listPlugins()[0];
    assert.equal(plugin.functions[0], '_');
  });
});

// ── invoke ─────────────────────────────────────────────────────

describe('invoke', () => {
  it('calls the registered function and returns its result', async () => {
    sk.registerPlugin('Math', { square: ({ n }) => n * n });
    const out = await sk.invoke('Math', 'square', { n: 5 });
    assert.equal(out, 25);
  });

  it('passes context + kernel + memory into the function', async () => {
    let captured;
    sk.registerPlugin('Probe', { introspect: (_args, ctx) => { captured = ctx; return 'ok'; } });
    await sk.invoke('Probe', 'introspect', {}, { userId: 'u1' });
    assert.equal(captured.userId, 'u1');
    assert.ok(captured.kernel);
    assert.ok(captured.memory);
  });

  it('throws on unregistered plugin', async () => {
    await assert.rejects(
      () => sk.invoke('Unknown', 'fn', {}),
      /plugin "Unknown" not registered/,
    );
  });

  it('throws on unregistered function within plugin', async () => {
    sk.registerPlugin('Math', { add: () => null });
    await assert.rejects(
      () => sk.invoke('Math', 'subtract', {}),
      /function "subtract" not registered/,
    );
  });

  it('lookup uses normalized names', async () => {
    sk.registerPlugin('My Plugin', { 'Do Thing': () => 'ok' });
    const out = await sk.invoke('My Plugin', 'Do Thing', {});
    assert.equal(out, 'ok');
  });
});

// ── listPlugins ────────────────────────────────────────────────

describe('listPlugins', () => {
  it('returns [] when empty', () => {
    assert.deepEqual(sk.listPlugins(), []);
  });

  it('lists registered plugins with function names', () => {
    sk.registerPlugin('Math', { add: () => null, sub: () => null });
    sk.registerPlugin('Text', { upper: () => null });
    const plugins = sk.listPlugins();
    assert.equal(plugins.length, 2);
    const math = plugins.find(p => p.name === 'math');
    assert.deepEqual(math.functions.sort(), ['add', 'sub']);
  });
});

// ── createAgent ────────────────────────────────────────────────

describe('createAgent', () => {
  it('throws when name missing', () => {
    assert.throws(() => sk.createAgent({ instructions: 'do x' }), /name required/);
  });

  it('throws when instructions missing', () => {
    assert.throws(() => sk.createAgent({ name: 'a' }), /instructions required/);
  });

  it('throws when plugins reference unregistered plugin', () => {
    assert.throws(
      () => sk.createAgent({ name: 'a', instructions: 'x', plugins: ['unknown_plugin'] }),
      /missing plugins/,
    );
  });

  it('returns an agent record with id sk_agent_<name>', () => {
    sk.registerPlugin('Math', { add: () => null });
    const agent = sk.createAgent({ name: 'MyAgent', instructions: 'solve math', plugins: ['Math'] });
    assert.equal(agent.id, 'sk_agent_myagent');
    assert.equal(agent.name, 'myagent');
    assert.equal(agent.instructions, 'solve math');
    assert.deepEqual(agent.plugins, ['math']);
  });

  it('accepts an empty plugins list', () => {
    const agent = sk.createAgent({ name: 'Agent', instructions: 'do nothing' });
    assert.deepEqual(agent.plugins, []);
  });
});

// ── runAgent ───────────────────────────────────────────────────

describe('runAgent', () => {
  it('throws when agent argument lacks a name', async () => {
    await assert.rejects(() => sk.runAgent({}), /agent required/);
    await assert.rejects(() => sk.runAgent(null), /agent required/);
  });

  it('returns input as output (no tool_calls) when agent has no plugins', async () => {
    const agent = sk.createAgent({ name: 'A', instructions: 'do x' });
    const out = await sk.runAgent(agent, { input: 'hello' });
    assert.equal(out.output, 'hello');
    assert.deepEqual(out.tool_calls, []);
  });

  it('routes to the first function of the first plugin when no tool arg', async () => {
    sk.registerPlugin('Math', { add: ({ n }) => n + 1, sub: ({ n }) => n - 1 });
    const agent = sk.createAgent({ name: 'Doer', instructions: 'do math', plugins: ['Math'] });
    const out = await sk.runAgent(agent, { args: { n: 5 } });
    assert.equal(out.output, 6);
    assert.deepEqual(out.tool_calls, [{ plugin: 'math', function: 'add', args: { n: 5 } }]);
  });

  it('supports explicit "plugin.function" tool routing', async () => {
    sk.registerPlugin('Math', { add: ({ n }) => n + 1, sub: ({ n }) => n - 1 });
    const agent = sk.createAgent({ name: 'Doer', instructions: 'do math', plugins: ['Math'] });
    const out = await sk.runAgent(agent, { tool: 'Math.sub', args: { n: 5 } });
    assert.equal(out.output, 4);
    assert.equal(out.tool_calls[0].function, 'sub');
  });

  it('coerces input to "" when null/undefined and no plugin available', async () => {
    const agent = sk.createAgent({ name: 'A', instructions: 'do x' });
    const out = await sk.runAgent(agent, {});
    assert.equal(out.output, '');
  });
});

// ── memory ─────────────────────────────────────────────────────

describe('memory', () => {
  it('save+get round-trips through the same key', async () => {
    await sk.memory.save('users', 'u1', { name: 'Ada' });
    const out = await sk.memory.get('users', 'u1');
    assert.deepEqual(out, { name: 'Ada' });
  });

  it('get returns null for missing key', async () => {
    assert.equal(await sk.memory.get('users', 'missing'), null);
    assert.equal(await sk.memory.get('missing-bucket', 'k'), null);
  });

  it('save normalizes collection name', async () => {
    await sk.memory.save('My Collection', 'k', 'v');
    assert.equal(await sk.memory.get('my_collection', 'k'), 'v');
  });

  it('search finds rows by key substring (case-insensitive)', async () => {
    await sk.memory.save('users', 'user_ada', { role: 'eng' });
    await sk.memory.save('users', 'user_bob', { role: 'pm' });
    const out = await sk.memory.search('users', 'ADA');
    assert.equal(out.length, 1);
    assert.equal(out[0].key, 'user_ada');
  });

  it('search finds rows by value content (JSON.stringify match)', async () => {
    await sk.memory.save('docs', 'd1', { tag: 'astrology' });
    const out = await sk.memory.search('docs', 'astrology');
    assert.equal(out.length, 1);
  });

  it('search returns [] for unknown collection', async () => {
    assert.deepEqual(await sk.memory.search('nope', 'q'), []);
  });

  it('search caps results at 10', async () => {
    for (let i = 0; i < 20; i++) {
      await sk.memory.save('big', `k${i}`, { x: i });
    }
    const out = await sk.memory.search('big', 'k');
    assert.equal(out.length, 10);
  });

  it('accepts an external memory Map injected at construction', async () => {
    const externalMap = new Map();
    const external = createSemanticKernelAdapter({ memory: externalMap });
    await external.memory.save('shared', 'k', 'v');
    // The external memory map should have a bucket now.
    assert.equal(externalMap.size, 1);
  });
});

// ── module surface ──────────────────────────────────────────────

describe('module surface', () => {
  it('exports createSemanticKernelAdapter', () => {
    const mod = require('../src/services/agents/semantic-kernel-adapter');
    assert.deepEqual(Object.keys(mod), ['createSemanticKernelAdapter']);
  });
});
