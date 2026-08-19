/**
 * semantic-kernel-adapter
 *
 * Microsoft does not publish an official JavaScript/TypeScript Semantic
 * Kernel SDK. This adapter keeps the same enterprise concepts in-process:
 * kernel, plugins, functions, memory and agent handoffs. If the platform
 * later hosts an official Python/C# SK sidecar, this contract is the bridge.
 */

function createSemanticKernelAdapter({ memory = null } = {}) {
  const plugins = new Map();
  const memories = memory || new Map();

  function registerPlugin(pluginName, functions = {}) {
    const name = normalizeName(pluginName);
    if (!name) throw new Error('semantic-kernel-adapter.registerPlugin: pluginName required');
    const entries = Object.entries(functions || {});
    if (entries.length === 0) throw new Error('semantic-kernel-adapter.registerPlugin: functions required');

    const normalized = {};
    for (const [fnName, descriptor] of entries) {
      const cleanFn = normalizeName(fnName);
      const invoke = typeof descriptor === 'function' ? descriptor : descriptor?.invoke;
      if (!cleanFn || typeof invoke !== 'function') {
        throw new Error(`semantic-kernel-adapter.registerPlugin: invalid function "${fnName}"`);
      }
      normalized[cleanFn] = {
        name: cleanFn,
        description: descriptor?.description || `${name}.${cleanFn}`,
        schema: descriptor?.schema || null,
        invoke,
      };
    }
    plugins.set(name, { name, functions: normalized });
    return { plugin: name, functionCount: entries.length };
  }

  async function invoke(pluginName, functionName, args = {}, context = {}) {
    const plugin = plugins.get(normalizeName(pluginName));
    if (!plugin) throw new Error(`semantic-kernel-adapter.invoke: plugin "${pluginName}" not registered`);
    const fn = plugin.functions[normalizeName(functionName)];
    if (!fn) throw new Error(`semantic-kernel-adapter.invoke: function "${functionName}" not registered`);
    return fn.invoke(args, {
      ...context,
      kernel: api,
      memory: api.memory,
    });
  }

  function createAgent({ name, instructions, plugins: agentPlugins = [] } = {}) {
    const clean = normalizeName(name);
    if (!clean) throw new Error('semantic-kernel-adapter.createAgent: name required');
    if (!instructions) throw new Error('semantic-kernel-adapter.createAgent: instructions required');
    const missing = agentPlugins.map(normalizeName).filter((plugin) => !plugins.has(plugin));
    if (missing.length) throw new Error(`semantic-kernel-adapter.createAgent: missing plugins ${missing.join(', ')}`);
    return {
      id: `sk_agent_${clean}`,
      name: clean,
      instructions,
      plugins: agentPlugins.map(normalizeName),
    };
  }

  async function runAgent(agent, { input, tool, args = {}, context = {} } = {}) {
    if (!agent?.name) throw new Error('semantic-kernel-adapter.runAgent: agent required');
    const pluginNames = Array.isArray(agent.plugins) ? agent.plugins : [];
    const selected = tool ? String(tool).split('.') : [];
    const pluginName = selected[0] || pluginNames[0];
    const functionName = selected[1] || firstFunctionName(pluginName);
    if (!pluginName || !functionName) {
      return { agent: agent.name, output: String(input || ''), tool_calls: [] };
    }
    const output = await invoke(pluginName, functionName, args, { ...context, input, agent });
    return {
      agent: agent.name,
      output,
      tool_calls: [{ plugin: pluginName, function: functionName, args }],
    };
  }

  function firstFunctionName(pluginName) {
    const plugin = plugins.get(normalizeName(pluginName));
    return plugin ? Object.keys(plugin.functions)[0] : null;
  }

  const api = {
    vendor: 'semantic-kernel-compatible',
    officialSdkRuntime: 'csharp-python-java-bridge',
    registerPlugin,
    invoke,
    createAgent,
    runAgent,
    listPlugins() {
      return [...plugins.values()].map((plugin) => ({
        name: plugin.name,
        functions: Object.keys(plugin.functions),
      }));
    },
    memory: {
      async save(collection, key, value) {
        const bucket = normalizeName(collection);
        if (!memories.has(bucket)) memories.set(bucket, new Map());
        memories.get(bucket).set(String(key), value);
        return { collection: bucket, key: String(key), saved: true };
      },
      async get(collection, key) {
        return memories.get(normalizeName(collection))?.get(String(key)) ?? null;
      },
      async search(collection, query) {
        const bucket = memories.get(normalizeName(collection));
        if (!bucket) return [];
        const q = String(query || '').toLowerCase();
        return [...bucket.entries()]
          .map(([key, value]) => ({ key, value, text: JSON.stringify(value) }))
          .filter((row) => row.key.toLowerCase().includes(q) || row.text.toLowerCase().includes(q))
          .slice(0, 10);
      },
    },
    capabilities() {
      return {
        plugins: true,
        memory: true,
        multi_agent: true,
        official_javascript_sdk: false,
        official_supported_languages: ['csharp', 'python', 'java'],
      };
    },
  };

  return api;
}

function normalizeName(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '_');
}

module.exports = {
  createSemanticKernelAdapter,
};
