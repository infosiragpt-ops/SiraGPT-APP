/**
 * Tests for plugin-registry.js
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  PluginRegistry, PluginInstance, getPluginRegistry, LIFECYCLE_EVENTS, PLUGIN_STATES,
} = require('../src/services/agents/plugin-registry');

describe('PluginInstance', () => {
  it('creates plugin in DISCOVERED state', () => {
    const plugin = new PluginInstance(
      { id: 'test-plugin', name: 'Test', version: '1.0.0', description: 'A test plugin', author: 'me' },
      async () => ({})
    );
    assert.strictEqual(plugin.state, PLUGIN_STATES.DISCOVERED);
    assert.strictEqual(plugin.id, 'test-plugin');
  });

  it('load transitions state and calls factory', async () => {
    let factoryCalled = false;
    const plugin = new PluginInstance(
      { id: 'factory-test', name: 'Test', version: '1.0.0', description: 'Test factory', author: 'me' },
      async (api) => {
        factoryCalled = true;
        assert.ok(api.pluginId);
        assert.ok(api.log);
        return { hooks: {}, tools: [] };
      }
    );
    await plugin.load({ pluginId: plugin.id, log: { info: () => {} } });
    assert.strictEqual(factoryCalled, true);
    assert.strictEqual(plugin.state, PLUGIN_STATES.LOADED);
  });

  it('load transitions to ERROR on factory failure', async () => {
    const plugin = new PluginInstance(
      { id: 'fail-plugin', name: 'Fail', version: '1.0.0', description: 'Fails', author: 'me' },
      async () => { throw new Error('load failed'); }
    );
    await assert.rejects(plugin.load({}), /load failed/);
    assert.strictEqual(plugin.state, PLUGIN_STATES.ERROR);
  });

  it('enable transitions to ENABLED and registers tools/hooks', async () => {
    const plugin = new PluginInstance(
      { id: 'enable-test', name: 'Test', version: '1.0.0', description: 'Enable test', author: 'me' },
      async (api) => ({
        hooks: { 'agent:beforeRun': async (ctx) => { ctx.modified = true; } },
        tools: [{ name: 'custom_search', description: 'Custom search', execute: async () => 'results' }],
        skills: [{ id: 'custom-skill', name: 'Custom Skill' }],
      })
    );
    await plugin.load({ pluginId: plugin.id, log: { info: () => {} } });
    plugin.enable();
    assert.strictEqual(plugin.state, PLUGIN_STATES.ENABLED);
    assert.strictEqual(plugin.tools.size, 1);
    assert.strictEqual(plugin.skills.size, 1);
    assert.ok(plugin.hasHook('agent:beforeRun'));
  });

  it('disable clears hooks and tools', () => {
    const plugin = new PluginInstance(
      { id: 'disable-test', name: 'Disable', version: '1.0.0', description: 'Disable test', author: 'me' },
      async () => ({ hooks: { 'agent:beforeRun': async () => {} }, tools: [{ name: 'tool1' }] })
    );
    plugin.state = PLUGIN_STATES.LOADED;
    plugin._hooks.set('agent:beforeRun', async () => {});
    plugin.tools.set('tool1', { name: 'tool1' });
    plugin.disable();
    assert.strictEqual(plugin.state, PLUGIN_STATES.DISABLED);
    assert.strictEqual(plugin.tools.size, 0);
    assert.strictEqual(plugin.hasHook('agent:beforeRun'), false);
  });

  it('info returns metadata snapshot', () => {
    const plugin = new PluginInstance(
      { id: 'info-test', name: 'Info Plugin', version: '2.0.0', description: 'Description', author: 'author' },
      async () => ({})
    );
    const info = plugin.info();
    assert.strictEqual(info.id, 'info-test');
    assert.strictEqual(info.name, 'Info Plugin');
    assert.strictEqual(info.version, '2.0.0');
    assert.ok(info.createdAt);
  });
});

describe('PluginRegistry', () => {
  it('register plugin with valid manifest', async () => {
    const registry = new PluginRegistry();
    const plugin = await registry.register(
      { id: 'simple', name: 'Simple Plugin', version: '1.0.0', description: 'Works', author: 'test' },
      async (api) => ({ hooks: {}, tools: [] })
    );
    assert.strictEqual(registry.size, 1);
    assert.strictEqual(plugin.state, PLUGIN_STATES.ENABLED);
  });

  it('rejects duplicate plugin ids', async () => {
    const registry = new PluginRegistry();
    await registry.register(
      { id: 'dup', name: 'First', version: '1.0.0', description: 'First', author: 'test' },
      async () => ({})
    );
    await assert.rejects(
      registry.register(
        { id: 'dup', name: 'Second', version: '1.0.0', description: 'Duplicate', author: 'test' },
        async () => ({})
      ),
      /already registered/
    );
  });

  it('rejects manifest without required fields', async () => {
    const registry = new PluginRegistry();
    await assert.rejects(
      registry.register(
        { id: 'no-name', version: '1.0.0', description: 'Missing', author: 'test' },
        async () => ({})
      ),
      /required/
    );
  });

  it('getPlugin returns null for unknown plugin', () => {
    const registry = new PluginRegistry();
    assert.strictEqual(registry.getPlugin('nonexistent'), null);
  });

  it('getAll returns all registered plugins', async () => {
    const registry = new PluginRegistry();
    await registry.register(
      { id: 'alpha', name: 'Alpha', version: '1.0.0', description: 'First', author: 'test' },
      async () => ({})
    );
    await registry.register(
      { id: 'beta', name: 'Beta', version: '1.0.0', description: 'Second', author: 'test' },
      async () => ({})
    );
    assert.strictEqual(registry.getAll().length, 2);
  });

  it('getEnabled returns only enabled plugins', async () => {
    const registry = new PluginRegistry();
    const plugin = await registry.register(
      { id: 'will-disable', name: 'Disable Me', version: '1.0.0', description: 'Test', author: 'test' },
      async () => ({})
    );
    assert.strictEqual(registry.getEnabled().length, 1);
    plugin.disable();
    assert.strictEqual(registry.getEnabled().length, 0);
  });

  it('hooks returns handlers for a specific event', async () => {
    const registry = new PluginRegistry();
    await registry.register(
      { id: 'hooker', name: 'Hook Plugin', version: '1.0.0', description: 'Has hooks', author: 'test', hooks: ['agent:beforeRun'] },
      async (api) => {
        api.on('agent:beforeRun', async (ctx) => { ctx.hooked = true; });
        return { hooks: { 'agent:beforeRun': async (ctx) => { ctx.hooked = true; } } };
      }
    );
    const hooks = registry.hooks('agent:beforeRun');
    assert.strictEqual(hooks.length, 1);
    assert.strictEqual(hooks[0].pluginId, 'hooker');
  });

  it('emit runs all hooks for an event', async () => {
    const registry = new PluginRegistry();
    await registry.register(
      { id: 'emit-test', name: 'Emit Test', version: '1.0.0', description: 'Test emit', author: 'test' },
      async (api) => {
        api.on('agent:beforeRun', async (ctx) => { ctx.results.push('handler1'); });
        return { hooks: { 'agent:beforeRun': async (ctx) => { ctx.results.push('handler1'); } } };
      }
    );
    const ctx = { results: [] };
    const results = await registry.emit('agent:beforeRun', ctx);
    assert.strictEqual(results.length, 1);
  });

  it('emit continues even if one handler throws', async () => {
    const registry = new PluginRegistry();
    await registry.register(
      { id: 'throws', name: 'Throws', version: '1.0.0', description: 'Throws', author: 'test' },
      async (api) => {
        api.on('agent:beforeRun', async () => { throw new Error('handler error'); });
        return { hooks: { 'agent:beforeRun': async () => { throw new Error('handler error'); } } };
      }
    );
    const results = await registry.emit('agent:beforeRun', {});
    assert.strictEqual(results.length, 1);
    assert.ok(results[0].error.includes('handler error'));
  });

  it('emit returns empty array when no plugins listen', async () => {
    const registry = new PluginRegistry();
    const results = await registry.emit('agent:beforeRun', {});
    assert.strictEqual(results.length, 0);
  });

  it('unregister removes plugin', async () => {
    const registry = new PluginRegistry();
    await registry.register(
      { id: 'remove-me', name: 'Remove', version: '1.0.0', description: 'Removed', author: 'test' },
      async () => ({})
    );
    assert.strictEqual(registry.size, 1);
    await registry.unregister('remove-me');
    assert.strictEqual(registry.size, 0);
  });

  it('getAllPluginTools aggregates across plugins', async () => {
    const registry = new PluginRegistry();
    await registry.register(
      { id: 'tool-plugin-1', name: 'Tools 1', version: '1.0.0', description: 'Tool provider', author: 'test' },
      async (api) => {
        api.registerTool({ name: 'search_web', description: 'Search the web' });
        return { tools: [{ name: 'search_web', description: 'Search the web' }] };
      }
    );
    const tools = registry.getAllPluginTools();
    assert.strictEqual(tools.size, 1);
    assert.ok(tools.has('search_web'));
  });

  it('snapshot returns array of plugin infos', async () => {
    const registry = new PluginRegistry();
    await registry.register(
      { id: 'snap-test', name: 'Snapshot', version: '1.0.0', description: 'Snap', author: 'test' },
      async () => ({})
    );
    const snap = registry.snapshot();
    assert.strictEqual(snap.length, 1);
    assert.strictEqual(snap[0].state, PLUGIN_STATES.ENABLED);
  });
});

describe('getPluginRegistry (singleton)', () => {
  it('returns the same instance', () => {
    assert.strictEqual(getPluginRegistry(), getPluginRegistry());
  });
});

describe('LIFECYCLE_EVENTS', () => {
  it('includes all expected lifecycle events', () => {
    assert.ok(LIFECYCLE_EVENTS.includes('plugin:loaded'));
    assert.ok(LIFECYCLE_EVENTS.includes('plugin:enabled'));
    assert.ok(LIFECYCLE_EVENTS.includes('agent:beforeRun'));
    assert.ok(LIFECYCLE_EVENTS.includes('agent:afterRun'));
    assert.ok(LIFECYCLE_EVENTS.includes('app:beforeShutdown'));
  });
});

describe('PLUGIN_STATES', () => {
  it('includes all state transitions', () => {
    assert.strictEqual(PLUGIN_STATES.DISCOVERED, 'discovered');
    assert.strictEqual(PLUGIN_STATES.LOADED, 'loaded');
    assert.strictEqual(PLUGIN_STATES.ENABLED, 'enabled');
    assert.strictEqual(PLUGIN_STATES.DISABLED, 'disabled');
    assert.strictEqual(PLUGIN_STATES.ERROR, 'error');
  });
});
