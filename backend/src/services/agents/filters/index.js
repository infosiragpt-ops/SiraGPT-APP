'use strict';

/**
 * Filter pipeline (Open WebUI-style).
 *
 * Each filter is a self-contained module with:
 *   - id        : string, unique
 *   - priority  : number, ascending order (lower = earlier)
 *   - enabled   : boolean (default config)
 *   - options   : default options object
 *   - pre(ctx, options) : optional, may mutate ctx, return
 *                        `{ abort:true, reason, status?, message? }`
 *                        to short-circuit the request.
 *   - post(ctx, options): optional, may mutate ctx (e.g. ctx.response).
 *
 * Adding a new cross-cutting behaviour MUST be a single file under
 * `services/agents/filters/` plus an entry in FILTERS_CONFIG. The
 * runner and routes never need to change.
 *
 * Guarantees:
 *   - Filters run in priority order.
 *   - A filter that throws is logged and skipped — only an explicit
 *     `{ abort: true }` short-circuits the pipeline.
 *   - `post` filters ALWAYS run (even after an abort) so metrics /
 *     audit hooks observe every request.
 *   - Hooks are async and awaited — never block the event loop.
 */

const fs = require('fs');
const path = require('path');
const { audit } = require('../audit-log');

const FILTERS_DIR = __dirname;

// Default per-filter configuration. Routes/admin can override at boot
// or, in dev, via chokidar hot-reload (see _watchInDev).
const FILTERS_CONFIG = {
  'rate-limit':          { enabled: true,  options: {} },
  'redact-logs':         { enabled: true,  options: {} },
  'metrics':             { enabled: true,  options: {} },
  'conversation-memory': { enabled: true,  options: {} },
  'translate-prompt':    { enabled: false, options: {} },
};

let _filters = null;

function _loadFilters() {
  const files = fs.readdirSync(FILTERS_DIR).filter((f) => (
    f.endsWith('.js')
    && f !== 'index.js'
    && !f.endsWith('.test.js')
  ));
  const loaded = [];
  for (const f of files) {
    try {
      const mod = require(path.join(FILTERS_DIR, f));
      if (!mod || !mod.id) continue;
      loaded.push(mod);
    } catch (err) {
      console.warn(`[filters] failed to load ${f}:`, err.message);
    }
  }
  loaded.sort((a, b) => (a.priority || 0) - (b.priority || 0));
  return loaded;
}

function _getFilters() {
  if (!_filters) _filters = _loadFilters();
  return _filters;
}

function _isEnabled(filter) {
  const cfg = FILTERS_CONFIG[filter.id];
  if (cfg && typeof cfg.enabled === 'boolean') return cfg.enabled;
  return filter.enabled !== false;
}

function _optionsFor(filter) {
    const cfg = FILTERS_CONFIG[filter.id];
    // Merge default filter options with overrides. Empty {} is truthy
    // so a naive cfg.options || filter.options would silently drop the
    // filter's own defaults whenever the registry entry uses {}.
    return Object.assign({}, filter.options || {}, (cfg && cfg.options) || {});
  }

function _scopeMatches(filter, ctx) {
    const scopes = filter.scopes;
    if (!Array.isArray(scopes) || scopes.length === 0) return true;
    if (!ctx || !ctx.scope) return false;
    return scopes.includes(ctx.scope);
  }

  async function _runHook(hookName, ctx) {
    const filters = _getFilters();
    for (const filter of filters) {
      if (!_isEnabled(filter)) continue;
      if (!_scopeMatches(filter, ctx)) continue;
      const hook = filter[hookName];
    if (typeof hook !== 'function') continue;
    try {
      const result = await hook.call(filter, ctx, _optionsFor(filter));
      if (hookName === 'pre' && result && result.abort) {
        ctx.aborted = true;
        ctx.abortReason = result.reason || 'aborted';
        ctx.abortStatus = result.status || 400;
        ctx.abortMessage = result.message || result.reason || 'request aborted by filter';
        ctx.abortFilter = filter.id;
        ctx.abortMeta = result;
        try {
          audit({
            event: 'filter_pipeline_abort',
            filter: filter.id,
            reason: ctx.abortReason,
            status: ctx.abortStatus,
            userId: ctx.userId || null,
            scope: ctx.scope || null,
          });
        } catch (_) { /* never throw */ }
        return ctx;
      }
    } catch (err) {
      // A filter failure must NOT tumble the request.
      try {
        audit({
          event: 'filter_pipeline_error',
          filter: filter.id,
          hook: hookName,
          error: err && err.message ? err.message : String(err),
          userId: ctx.userId || null,
        });
      } catch (_) { /* swallow */ }
    }
  }
  return ctx;
}

async function runPre(ctx) {
  ctx = ctx || {};
  return _runHook('pre', ctx);
}

async function runPost(ctx) {
  ctx = ctx || {};
  return _runHook('post', ctx);
}

function listFilters() {
  return _getFilters().map((f) => ({
    id: f.id,
    priority: f.priority || 0,
    enabled: _isEnabled(f),
    options: _optionsFor(f),
      scopes: Array.isArray(f.scopes) ? f.scopes.slice() : null,
      hasPre: typeof f.pre === 'function',
    hasPost: typeof f.post === 'function',
  }));
}

function setFilterEnabled(id, enabled) {
  if (!FILTERS_CONFIG[id]) FILTERS_CONFIG[id] = { enabled: !!enabled, options: {} };
  else FILTERS_CONFIG[id].enabled = !!enabled;
}

function setFilterOptions(id, options) {
  if (!FILTERS_CONFIG[id]) FILTERS_CONFIG[id] = { enabled: true, options: options || {} };
  else FILTERS_CONFIG[id].options = options || {};
}

function _reload() {
  _filters = null;
  return _getFilters();
}

// Dev-only hot reload. Production never installs chokidar listeners
// (the require would also fail silently in environments without it).
function _watchInDev() {
  if (process.env.NODE_ENV === 'production') return;
  try {
    // eslint-disable-next-line global-require
    const chokidar = require('chokidar');
    chokidar.watch(FILTERS_DIR, { ignoreInitial: true }).on('all', () => {
      for (const f of Object.keys(require.cache)) {
        if (f.startsWith(FILTERS_DIR) && f !== __filename) delete require.cache[f];
      }
      _reload();
    });
  } catch (_) { /* chokidar not installed — skip */ }
}

if (process.env.FILTERS_HOT_RELOAD === '1') _watchInDev();

module.exports = {
  runPre,
  runPost,
  listFilters,
  setFilterEnabled,
  setFilterOptions,
  FILTERS_CONFIG,
  _reload,        // for tests
};
