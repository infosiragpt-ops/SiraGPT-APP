'use strict';

const crypto = require('crypto');

const { getPluginRegistry } = require('./plugin-registry');
const { bootHermesPlugins } = require('./hermes-plugin-bridge');
const { redactErrorMessage, redactString } = require('../../utils/secret-redactor');

const LIFECYCLE_VERSION = 'agent-plugin-lifecycle-2026-07';
const PROTECTED_CONTEXT_KEYS = [
  'runId',
  'userId',
  'chatId',
  'organizationId',
  'signal',
  'toolName',
  'args',
  'result',
  'error',
];
const SECRET_KEY_PATTERN = /(authorization|cookie|password|passwd|secret|token|api[-_]?key|private[-_]?key)/i;

function createAbortError() {
  const error = new Error('agent run aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw createAbortError();
}

function sanitizeHookValue(value, key = '', depth = 0, seen = new WeakSet()) {
  if (SECRET_KEY_PATTERN.test(key)) return '[REDACTED]';
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    const redacted = redactString(value);
    return redacted.length > 4000 ? `${redacted.slice(0, 3999)}...` : redacted;
  }
  if (typeof value !== 'object' || depth > 6) return String(value).slice(0, 4000);
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((entry) => sanitizeHookValue(entry, '', depth + 1, seen));
  }
  const sanitized = {};
  for (const [entryKey, entryValue] of Object.entries(value).slice(0, 80)) {
    sanitized[entryKey] = sanitizeHookValue(entryValue, entryKey, depth + 1, seen);
  }
  return sanitized;
}

function hookFailureCount(dispatch) {
  return (dispatch?.results || []).filter((entry) => entry.error || entry.timedOut).length;
}

class AgentPluginLifecycle {
  constructor(options = {}) {
    this.registry = options.registry || getPluginRegistry();
    this.signal = options.signal || null;
    this.identity = Object.freeze({
      userId: options.userId ? String(options.userId) : null,
      chatId: options.chatId ? String(options.chatId) : null,
      organizationId: options.organizationId ? String(options.organizationId) : null,
    });
    this.runId = options.runId || crypto.randomUUID();
    this._stats = {
      hookRuns: 0,
      hookFailures: 0,
      blocked: 0,
      pluginToolsAdded: 0,
      pluginToolConflicts: 0,
      pluginSkillsAdded: 0,
      pluginSkillConflicts: 0,
      invalidPluginSkills: 0,
    };
  }

  addPluginTools(tools = []) {
    const merged = Array.isArray(tools) ? [...tools] : [];
    const names = new Set(merged.map((tool) => tool?.name).filter(Boolean));
    for (const [name, tool] of this.registry.getAllPluginTools({ trustedOnly: true })) {
      if (!tool || typeof tool.execute !== 'function') continue;
      if (names.has(name)) {
        this._stats.pluginToolConflicts += 1;
        continue;
      }
      merged.push(tool);
      names.add(name);
      this._stats.pluginToolsAdded += 1;
    }
    return merged;
  }

  addPluginSkills(tools = [], options = {}) {
    const merged = Array.isArray(tools) ? [...tools] : [];
    if (options.enabled === false) return merged;
    const runSkillIndex = merged.findIndex((tool) => tool?.name === 'run_skill');
    if (runSkillIndex < 0) return merged;

    const pluginSkills = this.registry.getAllPluginSkills({ trustedOnly: true });
    if (pluginSkills.size === 0) return merged;

    const skillRunner = options.skillRunner || require('./skill-runner');
    const enhanced = skillRunner.buildRunSkillTool({
      ctx: options.ctx || {},
      allowedSkillIds: Array.isArray(options.allowedSkillIds) ? options.allowedSkillIds : null,
      recommendedSkillIds: Array.isArray(options.recommendedSkillIds) ? options.recommendedSkillIds : [],
      pluginSkills,
    }, options.skillsModule || null);
    if (!enhanced) return merged;

    merged[runSkillIndex] = enhanced;
    this._stats.pluginSkillsAdded += enhanced.__pluginSkillIds?.length || 0;
    this._stats.pluginSkillConflicts += enhanced.__pluginSkillConflicts?.length || 0;
    this._stats.invalidPluginSkills += enhanced.__invalidPluginSkillIds?.length || 0;
    return merged;
  }

  async beforeRun(input = {}) {
    assertNotAborted(this.signal);
    const context = {
      runId: this.runId,
      ...this.identity,
      query: String(sanitizeHookValue(input.query || '')).slice(0, 12000),
      model: input.model ? String(input.model) : null,
      toolNames: Array.isArray(input.toolNames) ? input.toolNames.map(String).slice(0, 250) : [],
      memoryPrompt: '',
      signal: this.signal,
    };
    const dispatched = await this.registry.dispatch('agent:beforeRun', context, {
      signal: this.signal,
      protectedKeys: PROTECTED_CONTEXT_KEYS,
      allowBlocking: true,
      allowUntrustedMutation: false,
    });
    this._record(dispatched);
    if (dispatched.cancelled) throw createAbortError();
    if (dispatched.blocked) throw this._blockedError(dispatched.reason, 'PLUGIN_RUN_BLOCKED');
    const memoryPrompt = String(dispatched.context?.memoryPrompt || '').trim().slice(0, 8000);
    return {
      memoryPrompt,
      promptBlock: memoryPrompt
        ? `\n=== MEMORIA RELEVANTE APORTADA POR PLUGINS ===\n${memoryPrompt}\n=== FIN MEMORIA DE PLUGINS ===`
        : '',
      dispatch: dispatched,
    };
  }

  wrapTools(tools = []) {
    return (Array.isArray(tools) ? tools : []).map((tool) => {
      if (!tool || typeof tool.execute !== 'function') return tool;
      const lifecycle = this;
      return {
        ...tool,
        execute: async function executeWithPluginLifecycle(args, ctx) {
          const signal = ctx?.signal || lifecycle.signal;
          assertNotAborted(signal);
          const callContext = {
            runId: lifecycle.runId,
            ...lifecycle.identity,
            toolName: String(tool.name || 'unknown'),
            args: sanitizeHookValue(args),
            signal,
          };
          const before = await lifecycle.registry.dispatch('agent:toolCall', callContext, {
            signal,
            protectedKeys: PROTECTED_CONTEXT_KEYS,
            allowBlocking: true,
            allowUntrustedMutation: false,
          });
          lifecycle._record(before);
          if (before.cancelled) throw createAbortError();
          if (before.blocked) throw lifecycle._blockedError(before.reason, 'PLUGIN_TOOL_BLOCKED');
          assertNotAborted(signal);

          try {
            const result = await tool.execute(args, ctx);
            assertNotAborted(signal);
            const after = await lifecycle.registry.dispatch('agent:toolResult', {
              runId: lifecycle.runId,
              ...lifecycle.identity,
              toolName: String(tool.name || 'unknown'),
              result: sanitizeHookValue(result),
              signal,
            }, {
              signal,
              protectedKeys: PROTECTED_CONTEXT_KEYS,
              allowBlocking: false,
              allowUntrustedMutation: false,
            });
            lifecycle._record(after);
            if (after.cancelled) throw createAbortError();
            return result;
          } catch (error) {
            if (error?.code !== 'ABORT_ERR') {
              await lifecycle.error(error, { phase: 'tool', toolName: tool.name });
            }
            throw error;
          }
        },
      };
    });
  }

  async afterRun(result = {}) {
    assertNotAborted(this.signal);
    const dispatched = await this.registry.dispatch('agent:afterRun', {
      runId: this.runId,
      ...this.identity,
      stoppedReason: result?.stoppedReason || 'finalized',
      finalAnswer: String(sanitizeHookValue(result?.finalAnswer || '')).slice(0, 8000),
      stepCount: Array.isArray(result?.steps) ? result.steps.length : 0,
      signal: this.signal,
    }, {
      signal: this.signal,
      protectedKeys: PROTECTED_CONTEXT_KEYS,
      allowBlocking: false,
      allowUntrustedMutation: false,
    });
    this._record(dispatched);
    return dispatched;
  }

  async error(error, details = {}) {
    const dispatched = await this.registry.dispatch('agent:error', {
      runId: this.runId,
      ...this.identity,
      phase: String(details.phase || 'run'),
      toolName: details.toolName ? String(details.toolName) : null,
      error: {
        name: String(error?.name || 'Error'),
        code: error?.code ? String(error.code) : null,
        message: String(redactErrorMessage(error) || 'agent run failed').slice(0, 1000),
      },
      signal: this.signal,
    }, {
      protectedKeys: PROTECTED_CONTEXT_KEYS,
      allowBlocking: false,
      allowUntrustedMutation: false,
    });
    this._record(dispatched);
    return dispatched;
  }

  summary() {
    return {
      version: LIFECYCLE_VERSION,
      enabledPlugins: this.registry.getEnabled().length,
      activeHooks: this.registry.hookHealth().filter((hook) => hook.totalRuns > 0).length,
      ...this._stats,
    };
  }

  _record(dispatched) {
    this._stats.hookRuns += dispatched?.results?.length || 0;
    this._stats.hookFailures += hookFailureCount(dispatched);
    if (dispatched?.blocked) this._stats.blocked += 1;
  }

  _blockedError(reason, code) {
    const error = new Error(String(reason || 'blocked by trusted plugin').slice(0, 240));
    error.code = code;
    return error;
  }
}

async function prepareAgentPluginLifecycle(options = {}) {
  if (options.bootPlugins !== false) {
    const boot = typeof options.bootPlugins === 'function' ? options.bootPlugins : bootHermesPlugins;
    await boot();
  }
  return new AgentPluginLifecycle(options);
}

module.exports = {
  AgentPluginLifecycle,
  LIFECYCLE_VERSION,
  prepareAgentPluginLifecycle,
  sanitizeHookValue,
};
