/**
 * plugin-registry — lightweight plugin/extension system for SiraGPT.
 *
 * Problem:
 *   Adding new capabilities (a new provider, a new tool, a new agent
 *   skill) requires modifying the core codebase. There's no mechanism
 *   for third-party extensions or feature toggles.
 *
 * Solution:
 *   A plugin registry where extensions register themselves by declaring
 *   a manifest. The core runtime only knows about the registry — plugins
 *   use it to register lifecycle hooks, tools, skills, and event handlers.
 *
 * Plugin lifecycle:
 *   DISCOVERED → LOADED → ENABLED → DISABLED
 *
 * Architecture:
 *   PluginRegistry (singleton)
 *     ├── register(manifest, factory)
 *     ├── unregister(pluginId)
 *     ├── getPlugin(id) → PluginInstance
 *     ├── getAll() → PluginInstance[]
 *     ├── hooks(eventName) → PluginHook[]
 *     └── emit(eventName, context) → runs all hooks for event
 *
 * Plugin manifest format:
 *   {
 *     id: 'string',            // unique, e.g. 'email-assistant'
 *     name: 'string',          // human-readable, e.g. 'Email Assistant'
 *     version: 'semver',
 *     description: 'string',
 *     author: 'string',
 *     hooks: ['string'],       // lifecycle events this plugin reacts to
 *     capabilities: ['string'],// 'tools', 'skills', 'providers', 'hooks'
 *     requires: ['string'],    // plugin dependencies
 *     configSchema: object,    // JSON Schema for plugin config
 *   }
 *
 * Design principles:
 *   - NO code copying from OpenClaw's extension system — this is a
 *     simpler, purpose-built registry for SiraGPT's architecture.
 *   - Each plugin is isolated: no direct access to other plugins' state.
 *   - Lifecycle hooks are the only communication channel between plugins.
 *   - Plugins can add tools, skills, providers, and event handlers.
 *   - Graceful failure: one plugin's error doesn't crash others.
 */

const EventEmitter = require('events');
const { getLogger } = require('./structured-logger');

const log = getLogger('plugin-registry');

// ─── Constants ─────────────────────────────────────────────────────────────

const LIFECYCLE_EVENTS = [
  'plugin:beforeLoad',
  'plugin:loaded',
  'plugin:enabled',
  'plugin:disabled',
  'plugin:error',
  'plugin:beforeUnload',
  'plugin:unloaded',
  'agent:beforeRun',
  'agent:afterRun',
  'agent:toolCall',
  'agent:toolResult',
  'agent:error',
  'app:beforeShutdown',
  'app:startup',
];

const PLUGIN_STATES = Object.freeze({
  DISCOVERED: 'discovered',
  LOADING: 'loading',
  LOADED: 'loaded',
  ENABLING: 'enabling',
  ENABLED: 'enabled',
  DISABLING: 'disabling',
  DISABLED: 'disabled',
  ERROR: 'error',
  UNLOADING: 'unloading',
  UNLOADED: 'unloaded',
});

// ─── PluginInstance ────────────────────────────────────────────────────────

class PluginInstance {
  /**
   * @param {object} manifest     — plugin manifest
   * @param {Function} factory    — async (api) => pluginExports
   */
  constructor(manifest, factory) {
    this.manifest = manifest;
    this.id = manifest.id;
    this.state = PLUGIN_STATES.DISCOVERED;
    this.exports = null;
    this._factory = factory;
    this._hooks = new Map();
    this._error = null;
    this.tools = new Map();
    this.skills = new Map();
    this.providers = new Map();
    this.createdAt = new Date();
    this.updatedAt = this.createdAt;
  }

  /**
   * Load the plugin (calls its factory function).
   * @param {object} api  — plugin API object
   */
  async load(api) {
    if (this.state !== PLUGIN_STATES.DISCOVERED) return;
    this.state = PLUGIN_STATES.LOADING;

    try {
      this.exports = await this._factory(api);
      this.state = PLUGIN_STATES.LOADED;
      this.updatedAt = new Date();
      log.info('plugin loaded', { pluginId: this.id });
    } catch (err) {
      this.state = PLUGIN_STATES.ERROR;
      this._error = err;
      log.error('plugin load failed', { pluginId: this.id, error: err.message });
      throw err;
    }
  }

  /**
   * Enable the plugin (bind its hooks).
   */
  enable() {
    if (this.state !== PLUGIN_STATES.LOADED) return;
    this.state = PLUGIN_STATES.ENABLED;
    this.updatedAt = new Date();

    // Register hooks from plugin exports
    if (this.exports?.hooks) {
      for (const [event, handler] of Object.entries(this.exports.hooks)) {
        this._hooks.set(event, handler);
      }
    }

    // Register tools from plugin exports
    if (this.exports?.tools) {
      for (const tool of this.exports.tools) {
        if (tool && tool.name) {
          this.tools.set(tool.name, tool);
        }
      }
    }

    // Register skills from plugin exports
    if (this.exports?.skills) {
      for (const skill of this.exports.skills) {
        if (skill && skill.id) {
          this.skills.set(skill.id, skill);
        }
      }
    }

    // Register providers from plugin exports
    if (this.exports?.providers) {
      for (const provider of this.exports.providers) {
        if (provider && provider.name) {
          this.providers.set(provider.name, provider);
        }
      }
    }

    log.info('plugin enabled', {
      pluginId: this.id,
      hooks: this._hooks.size,
      tools: this.tools.size,
      skills: this.skills.size,
    });
  }

  /**
   * Disable the plugin (unbind hooks).
   */
  disable() {
    this.state = PLUGIN_STATES.DISABLED;
    this._hooks.clear();
    this.tools.clear();
    this.skills.clear();
    this.providers.clear();
    this.updatedAt = new Date();
    log.info('plugin disabled', { pluginId: this.id });
  }

  /**
   * Get a hook handler by event name.
   */
  getHook(event) {
    return this._hooks.get(event) || null;
  }

  /**
   * Whether this plugin has a handler for a given event.
   */
  hasHook(event) {
    return this._hooks.has(event);
  }

  /**
   * Plugin metadata.
   */
  info() {
    return {
      id: this.id,
      name: this.manifest.name,
      version: this.manifest.version,
      description: this.manifest.description,
      author: this.manifest.author,
      state: this.state,
      hooks: Array.from(this._hooks.keys()),
      toolCount: this.tools.size,
      skillCount: this.skills.size,
      providerCount: this.providers.size,
      error: this._error?.message || null,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}

// ─── PluginRegistry ────────────────────────────────────────────────────────

class PluginRegistry extends EventEmitter {
  constructor() {
    super();
    this._plugins = new Map();
    this._initialized = false;
  }

  /**
   * Initialize the registry (empty for now — plugins register themselves).
   */
  async initialize() {
    if (this._initialized) return;
    this._initialized = true;
    log.info('plugin registry initialized');
  }

  /**
   * Register a plugin.
   *
   * @param {object} manifest    — plugin manifest
   * @param {Function} factory   — async (api) => { hooks, tools, skills, providers }
   * @returns {PluginInstance}
   */
  async register(manifest, factory) {
    if (!manifest || !manifest.id) {
      throw new Error('PluginRegistry.register: manifest.id is required');
    }
    if (this._plugins.has(manifest.id)) {
      throw new Error(`Plugin "${manifest.id}" is already registered`);
    }

    // Validate manifest
    this._validateManifest(manifest);

    const plugin = new PluginInstance(manifest, factory);

    try {
      await plugin.load(this._createPluginAPI(plugin));
      plugin.enable();
      this._plugins.set(manifest.id, plugin);
      this.emit('pluginRegistered', plugin.info());
      log.info('plugin registered', { pluginId: plugin.id, version: manifest.version });
    } catch (err) {
      log.error('plugin registration failed', { pluginId: manifest.id, error: err.message });
      // Still store it in error state so introspection works
      if (!this._plugins.has(manifest.id)) {
        this._plugins.set(manifest.id, plugin);
      }
      throw err;
    }

    return plugin;
  }

  /**
   * Unregister a plugin.
   */
  async unregister(pluginId) {
    const plugin = this._plugins.get(pluginId);
    if (!plugin) throw new Error(`Plugin "${pluginId}" not found`);

    this.emit('plugin:beforeUnload', { pluginId });
    plugin.disable();
    this._plugins.delete(pluginId);
    this.emit('plugin:unloaded', { pluginId });
    log.info('plugin unregistered', { pluginId });
  }

  /**
   * Get a plugin by ID.
   */
  getPlugin(pluginId) {
    return this._plugins.get(pluginId) || null;
  }

  /**
   * Get all registered plugins.
   */
  getAll() {
    return Array.from(this._plugins.values());
  }

  /**
   * Get enabled plugins only.
   */
  getEnabled() {
    return Array.from(this._plugins.values()).filter(p => p.state === PLUGIN_STATES.ENABLED);
  }

  /**
   * Get all hooks for a given event across all enabled plugins.
   * Hooks are called in order of plugin registration.
   *
   * @param {string} event  — event name
   * @returns {Array<{ pluginId: string, handler: Function }>}
   */
  hooks(event) {
    const results = [];
    for (const plugin of this.getEnabled()) {
      const handler = plugin.getHook(event);
      if (handler) {
        results.push({ pluginId: plugin.id, handler });
      }
    }
    return results;
  }

  /**
   * Emit an event to all plugins that have a handler for it.
   * Each plugin's handler is called sequentially. If one handler throws,
   * subsequent handlers still run (fire-and-continue).
   *
   * @param {string} event  — event name
   * @param {object} context — event payload
   * @returns {Promise<Array<{ pluginId: string, result?: any, error?: string }>>}
   */
  async emit(event, context = {}) {
    const handlers = this.hooks(event);
    const results = [];

    for (const { pluginId, handler } of handlers) {
      try {
        const result = await handler(context, { pluginId, registry: this });
        results.push({ pluginId, result });
      } catch (err) {
        log.warn('plugin hook error', { pluginId, event, error: err.message });
        results.push({ pluginId, error: err.message });
        this.emit('plugin:error', { pluginId, event, error: err.message });
      }
    }

    return results;
  }

  /**
   * Get all tools registered by all plugins.
   * Plugin tools are merged with core tools — duplicates warn but don't block.
   *
   * @returns {Map<string, object>}
   */
  getAllPluginTools() {
    const tools = new Map();
    for (const plugin of this.getEnabled()) {
      for (const [name, tool] of plugin.tools) {
        if (tools.has(name)) {
          log.warn('duplicate plugin tool', { toolName: name, pluginId: plugin.id });
        }
        tools.set(name, tool);
      }
    }
    return tools;
  }

  /**
   * Get all skills registered by all plugins.
   */
  getAllPluginSkills() {
    const skills = new Map();
    for (const plugin of this.getEnabled()) {
      for (const [id, skill] of plugin.skills) {
        skills.set(id, skill);
      }
    }
    return skills;
  }

  /**
   * Get all providers registered by all plugins.
   */
  getAllPluginProviders() {
    const providers = new Map();
    for (const plugin of this.getEnabled()) {
      for (const [name, provider] of plugin.providers) {
        providers.set(name, provider);
      }
    }
    return providers;
  }

  /**
   * Snapshot of all plugin states for observability.
   */
  snapshot() {
    return this.getAll().map(p => p.info());
  }

  /**
   * Number of registered plugins.
   */
  get size() { return this._plugins.size; }

  /**
   * Whether the registry has been initialized.
   */
  get initialized() { return this._initialized; }

  /**
   * Validate a plugin manifest structure.
   */
  _validateManifest(manifest) {
    const required = ['id', 'name', 'version', 'description'];
    for (const field of required) {
      if (!manifest[field] || typeof manifest[field] !== 'string') {
        throw new Error(`Plugin manifest missing required string field: "${field}"`);
      }
    }

    if (manifest.hooks) {
      if (!Array.isArray(manifest.hooks)) {
        throw new Error('Plugin manifest "hooks" must be an array of strings');
      }
      for (const hook of manifest.hooks) {
        if (!LIFECYCLE_EVENTS.includes(hook)) {
          log.warn('unknown lifecycle event', { pluginId: manifest.id, hook });
        }
      }
    }

    if (manifest.requires && !Array.isArray(manifest.requires)) {
      throw new Error('Plugin manifest "requires" must be an array of strings');
    }
  }

  /**
   * Create the plugin API object passed to a plugin's factory function.
   * This is the ONLY interface through which plugins interact with the core.
   */
  _createPluginAPI(plugin) {
    const registry = this;
    return {
      // ── Core access ──────────────────────────────────────────────
      pluginId: plugin.id,
      log: getLogger(`plugin:${plugin.id}`),

      // ── Hooks ────────────────────────────────────────────────────
      on(event, handler) {
        if (!LIFECYCLE_EVENTS.includes(event)) {
          throw new Error(`Unknown lifecycle event: "${event}". Valid events: ${LIFECYCLE_EVENTS.join(', ')}`);
        }
        if (typeof handler !== 'function') {
          throw new Error('Hook handler must be a function');
        }
        // Store hooks directly on the plugin's internal map
        if (!plugin._hooks) plugin._hooks = new Map();
        plugin._hooks.set(event, handler);
      },

      // ── Registration ─────────────────────────────────────────────
      registerTool(tool) {
        if (!tool || !tool.name) {
          throw new Error('Tool must have a "name" property');
        }
        plugin.tools.set(tool.name, tool);
        log.info('plugin tool registered', { pluginId: plugin.id, tool: tool.name });
      },

      registerSkill(skill) {
        if (!skill || !skill.id) {
          throw new Error('Skill must have an "id" property');
        }
        plugin.skills.set(skill.id, skill);
      },

      registerProvider(adapter) {
        if (!adapter || !adapter.name) {
          throw new Error('Provider must have a "name" property');
        }
        plugin.providers.set(adapter.name, adapter);
      },

      // ── Configuration ────────────────────────────────────────────
      getConfig(path) {
        // Access plugin config from the global config store
        const config = registry._config || {};
        const pluginConfig = config.plugins?.[plugin.id];
        if (!path) return pluginConfig;
        return path.split('.').reduce((obj, key) => obj?.[key], pluginConfig);
      },
    };
  }

  /**
   * Inject global config for plugin access.
   * @param {object} config
   */
  setConfig(config) {
    this._config = config;
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────────

const globalRegistry = new PluginRegistry();

function getPluginRegistry() {
  return globalRegistry;
}

module.exports = {
  PluginRegistry,
  PluginInstance,
  getPluginRegistry,
  LIFECYCLE_EVENTS,
  PLUGIN_STATES,
};
