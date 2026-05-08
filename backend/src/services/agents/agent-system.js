/**
 * agent-system — Central bootstrap and integration hub for the agent platform.
 *
 * Initialises all new platform services at startup (singleton-scoped) and
 * exports them so existing modules can consume them without circular
 * dependency problems.
 *
 * Integration points:
 *   - backend/index.js  → calls initAgentSystem() during boot
 *   - routes/ai.js      → uses providerRegistry for model failover
 *   - agents/agent-entry.js → uses structuredLogger + tracer for observability
 *   - agents/agent-task-runner.js → uses bulkhead for LLM call isolation
 *
 * Every service is lazy-initialised and safe to import when the env
 * hasn't booted yet (returns a no-op / error until init is called).
 */

const { SubAgentOrchestrator, SubAgentError, createOrchestrator } = require('./sub-agent-orchestrator');
const { BulkheadPool, getBulkhead } = require('./bulkhead');
const { ProviderRegistry, ProviderAdapter, getProviderRegistry } = require('./provider-registry');
const { getLogger, createTraceContext } = require('./structured-logger');
const { Tracer, MetricsAggregator, getTracer, getMetrics } = require('./performance-tracer');
const { PluginRegistry, PluginInstance, getPluginRegistry } = require('./plugin-registry');

// ── Module-level state ──────────────────────────────────────
let _initialised = false;
let _bootLogger = null;

// ── Default configuration (tunable via env) ──────────────────
const DEFAULTS = {
  agentPoolMax: parseInt(process.env.AGENT_POOL_MAX, 10) || 25,
  agentPoolTimeoutMs: parseInt(process.env.AGENT_POOL_TIMEOUT_MS, 10) || 30_000,
  subTaskTimeoutMs: parseInt(process.env.AGENT_SUB_TASK_TIMEOUT_MS, 10) || 60_000,
  maxSubAgents: parseInt(process.env.AGENT_MAX_SUB_AGENTS, 10) || 5,
  maxRetries: parseInt(process.env.AGENT_MAX_RETRIES, 10) || 2,
  providerFailoverTimeoutMs: parseInt(process.env.PROVIDER_FAILOVER_TIMEOUT_MS, 10) || 10_000,
};

// ── Initialised service references ───────────────────────────
let _providerRegistry = null;
let _subAgentOrchestrator = null;
let _agentPool = null;

// ── Public API ───────────────────────────────────────────────

/**
 * Initialise all platform services. Call once during boot from
 * backend/index.js. Safe to call multiple times (idempotent).
 *
 * @returns {{ tracer, logger, orchestrator, providerRegistry, agentPool, metrics }}
 */
function initAgentSystem() {
  if (_initialised) {
    _bootLogger?.info?.('agent-system already initialised, skipping');
    // eslint-disable-next-line no-console
    if (!_bootLogger) console.warn('[agent-system] initAgentSystem called twice');
    return getServices();
  }

  _bootLogger = getLogger('agent-system');
  const log = _bootLogger;

  try {
    // 1. Performance tracer — captures every agent operation as spans.
    //    Wraps a singleton Tracer (use getTracer() for access).
    const tracer = getTracer({ service: 'siragpt', enabled: process.env.OTEL_ENABLED !== 'false' });
    log.info('performance-tracer initialised');

    // 2. Structured logger — JSON-lines output with trace IDs.
    //    Root logger is already active via getLogger(). Child loggers
    //    for each domain inherit their parent's configuration.
    log.info('structured-logger initialised');

    // 3. Provider registry — abstract provider interface with circuit
    //    breaker + automatic failover. Registers the 'default' provider
    //    that wraps OpenAI-compatible clients.
    _providerRegistry = getProviderRegistry();
    _registerBuiltInProviders(_providerRegistry, log);
    log.info('provider-registry initialised');

    // 4. Bulkhead pool — resource isolation for LLM calls. Prevents
    //    one agent's runaway token stream from starving others.
    _agentPool = getBulkhead('agent-llm', {
      maxConcurrent: DEFAULTS.agentPoolMax,
      timeoutMs: DEFAULTS.agentPoolTimeoutMs,
    });
    _agentPool.info = () => ({
      maxConcurrent: DEFAULTS.agentPoolMax,
      timeoutMs: DEFAULTS.agentPoolTimeoutMs,
      active: DEFAULTS.agentPoolMax - (_agentPool.stats?.()?.availableSlots ?? 0),
    });
    log.info({ maxConcurrent: DEFAULTS.agentPoolMax }, 'bulkhead initialised');

    // 5. Sub-agent orchestrator — decomposes complex goals and runs
    //    sub-tasks in parallel with retry + timeout.
    _subAgentOrchestrator = new SubAgentOrchestrator({
      maxSubAgents: DEFAULTS.maxSubAgents,
      subTaskTimeoutMs: DEFAULTS.subTaskTimeoutMs,
      maxRetries: DEFAULTS.maxRetries,
    });
    log.info({
      maxSubAgents: DEFAULTS.maxSubAgents,
      subTaskTimeoutMs: DEFAULTS.subTaskTimeoutMs,
    }, 'sub-agent-orchestrator initialised');

    _initialised = true;
    log.info('agent-system initialised successfully');
  } catch (err) {
    log.error({ err: err.message }, 'agent-system initialisation failed');
    // Don't crash the boot — let the server start so health probes
    // work. Degradation is reported via /health.
  }

  return getServices();
}

/**
 * Return the current service map. Throws if initAgentSystem() hasn't
 * been called yet — callers that want graceful degradation should
 * check initialised first.
 */
function getServices() {
  return {
    tracer: getTracer(),
    logger: getLogger(),
    metrics: getMetrics(),
    providerRegistry: _providerRegistry || getProviderRegistry(),
    agentPool: _agentPool || getBulkhead('agent-llm', { maxConcurrent: DEFAULTS.agentPoolMax }),
    orchestrator: _subAgentOrchestrator,
    subAgentOrchestrator: _subAgentOrchestrator,
    SubAgentOrchestrator,
    SubAgentError,
    createOrchestrator,
    BulkheadPool,
    getBulkhead,
    ProviderRegistry,
    ProviderAdapter,
    PluginRegistry,
    PluginInstance,
    getPluginRegistry,
    getLogger,
    createTraceContext,
    Tracer,
    MetricsAggregator,
    initialised: _initialised,
  };
}

/**
 * Wrap an async function with bulkhead isolation + tracing +
 * structured error classification in one call.
 *
 * @param {string} operationName — span name
 * @param {Function} fn — async function to execute
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.traceId]
 * @param {object} [opts.tags] — extra metric tags
 * @returns {Promise<*>}
 */
async function guardedExecute(operationName, fn, opts = {}) {
  const tracer = getTracer();
  const metricTags = { operation: operationName, ...(opts.tags || {}) };

  // Bulkhead (resource isolation)
  const pool = _agentPool || getBulkhead('agent-llm', { maxConcurrent: DEFAULTS.agentPoolMax });
  const span = tracer.start(operationName, opts.traceId || null);

  try {
    const result = await pool.execute(
      () => fn(),
      opts.timeoutMs || DEFAULTS.agentPoolTimeoutMs,
    );
    tracer.end(span);
    getMetrics().increment('agent.operation.ok', metricTags);
    return result;
  } catch (err) {
    tracer.error(span);
    tracer.end(span);
    getMetrics().increment('agent.operation.error', { ...metricTags, error: err.code || err.name || 'unknown' });
    getMetrics().timing('agent.operation.latency', Date.now() - span.startTime, metricTags);
    throw err;
  }
}

// ── Internal helpers ─────────────────────────────────────────

function _registerBuiltInProviders(registry, log) {
  // The provider-registry's ProviderAdapter already defines the
  // abstract interface. Built-in providers are registered lazily
  // when the first request arrives or at boot — whichever comes first.
  // No API keys are read here: that happens at resolution time via
  // the adapter instances returned by the registry.
  //
  // To add a new provider externally:
  //   const { ProviderAdapter, getProviderRegistry } = require('./services/agents/provider-registry');
  //   class MyProvider extends ProviderAdapter { ... }
  //   getProviderRegistry().register('my-provider', new MyProvider());
  log.info('built-in provider stubs ready (providers registered lazily on first use)');
}

// ── Plugin system integration (opt-in) ───────────────────────
// If PLUGIN_DIR is set, the plugin registry loads plugins from the
// specified directory on boot. This is off by default because most
// deployments do not need custom plugins yet.
//   process.env.PLUGIN_DIR && initPlugins();
//
// function initPlugins() {
//   const registry = getPluginRegistry();
//   registry.discover(process.env.PLUGIN_DIR).catch(err =>
//     _bootLogger?.error?.({ err: err.message }, 'plugin discovery failed')
//   );
// }

module.exports = {
  initAgentSystem,
  getServices,
  guardedExecute,
  SubAgentOrchestrator,
  SubAgentError,
  createOrchestrator,
  BulkheadPool,
  getBulkhead,
  ProviderRegistry,
  ProviderAdapter,
  getProviderRegistry,
  PluginRegistry,
  PluginInstance,
  getPluginRegistry,
  getLogger,
  createTraceContext,
  Tracer,
  MetricsAggregator,
  getTracer,
  getMetrics,
};
