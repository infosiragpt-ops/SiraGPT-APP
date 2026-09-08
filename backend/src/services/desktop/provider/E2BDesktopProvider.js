'use strict';

/**
 * E2BDesktopProvider — F7.1 real implementation.
 *
 * Isolated require('@e2b/desktop') so unit tests never need a live
 * E2B_API_KEY or the SDK on disk. Inject `Desktop` / `createDesktop`
 * for fakes. Missing key → fail CLOSED (Spanish), no network.
 *
 * Does not talk to siragpt-computer-orchestrator (#484 stays).
 */

const {
  DesktopProvider,
  DesktopProviderError,
  assertImplementsDesktopProvider,
} = require('./DesktopProvider');
const { sniffMediaType } = require('./LocalGvisorDesktopProvider');
const {
  E2B_KEY_MISSING_ES,
  E2B_SDK_MISSING_ES,
} = require('../desktop-errors');

function hasUsableKey(raw) {
  return Boolean(String(raw || '').trim());
}

/**
 * Lazy, isolated SDK load. Never at module top-level so
 * `node --test` without @e2b/desktop still boots this file.
 * @param {function} [requireFn]
 */
function loadE2BDesktopSdk(requireFn = require) {
  try {
    return requireFn('@e2b/desktop');
  } catch (err) {
    const wrapped = new DesktopProviderError(E2B_SDK_MISSING_ES, {
      code: 'desktop_e2b_sdk_missing',
      status: 503,
    });
    wrapped.cause = err;
    throw wrapped;
  }
}

function resolveDesktopCtor(mod) {
  if (!mod) return null;
  if (typeof mod.create === 'function') return mod;
  if (typeof mod.Sandbox === 'function') return mod.Sandbox;
  if (typeof mod.Desktop === 'function') return mod.Desktop;
  if (mod.default) return resolveDesktopCtor(mod.default);
  return null;
}

class E2BDesktopProvider extends DesktopProvider {
  /**
   * @param {object} [opts]
   * @param {object} [opts.env]
   * @param {string} [opts.apiKey]
   * @param {function|object} [opts.Desktop] injected SDK ctor or { create }
   * @param {function} [opts.createDesktop] injected factory (tests)
   * @param {function} [opts.requireFn] isolated require (tests)
   * @param {string} [opts.template] E2B template override
   * @param {number} [opts.timeoutMs]
   */
  constructor(opts = {}) {
    super();
    this.kind = 'e2b';
    this.opts = opts;
    this.env = opts.env || process.env;
    this.apiKey = opts.apiKey != null ? String(opts.apiKey) : String(this.env.E2B_API_KEY || '');
    this.domain = opts.domain != null ? opts.domain : (this.env.E2B_DOMAIN || '');
    this.template = opts.template || this.env.E2B_DESKTOP_TEMPLATE || '';
    this.timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 60_000;
    this._Desktop = opts.Desktop || null;
    this._createDesktop = typeof opts.createDesktop === 'function' ? opts.createDesktop : null;
    this._requireFn = opts.requireFn || null;
    /** @type {Map<string, object>} */
    this._sandboxes = new Map();
  }

  _key() {
    return String(this.apiKey || '').trim();
  }

  _assertKeyOrInjected() {
    if (this._createDesktop || this._Desktop) return;
    if (!hasUsableKey(this._key())) {
      throw new DesktopProviderError(E2B_KEY_MISSING_ES, {
        code: 'desktop_e2b_unconfigured',
        status: 503,
      });
    }
  }

  _resolveCtor() {
    if (this._Desktop) return resolveDesktopCtor(this._Desktop) || this._Desktop;
    const mod = loadE2BDesktopSdk(this._requireFn || require);
    const ctor = resolveDesktopCtor(mod);
    if (!ctor || typeof ctor.create !== 'function') {
      throw new DesktopProviderError(E2B_SDK_MISSING_ES, {
        code: 'desktop_e2b_sdk_missing',
        status: 503,
      });
    }
    return ctor;
  }

  async _openSandbox(createOpts) {
    if (this._createDesktop) {
      return this._createDesktop(createOpts);
    }
    const Desktop = this._resolveCtor();
    const template = String(this.template || '').trim();
    if (template) return Desktop.create(template, createOpts);
    return Desktop.create(createOpts);
  }

  async create(opts = {}) {
    this._assertKeyOrInjected();
    const createOpts = {
      apiKey: this._key() || undefined,
      timeoutMs: Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : this.timeoutMs,
    };
    const domain = String(this.domain || '').trim();
    if (domain) createOpts.domain = domain;

    const sandbox = await this._openSandbox(createOpts);
    const id = String(
      (sandbox && (sandbox.sandboxId || sandbox.id || sandbox.desktopId)) || `e2b-${Date.now().toString(36)}`,
    );
    this._sandboxes.set(id, sandbox);
    const display = (sandbox && sandbox.display) || ':0';
    const wsUrl = this._readWsUrl(sandbox);
    return {
      id,
      display,
      provider: 'e2b',
      wsUrl,
    };
  }

  async destroy(handle) {
    const id = handle && handle.id;
    if (!id) return;
    const sandbox = this._sandboxes.get(String(id));
    this._sandboxes.delete(String(id));
    if (!sandbox) return;
    try {
      if (typeof sandbox.kill === 'function') await sandbox.kill();
      else if (typeof sandbox.close === 'function') await sandbox.close();
    } catch (err) {
      if (/not found|already|does not exist/i.test(String(err && err.message))) return;
      throw err;
    }
  }

  async health(handle) {
    const sandbox = this._sandboxOf(handle);
    if (typeof sandbox.isRunning === 'function') {
      const running = await sandbox.isRunning();
      if (!running) {
        throw new DesktopProviderError('El escritorio E2B no está en ejecución.', {
          code: 'desktop_e2b_unhealthy',
          status: 503,
        });
      }
    } else if (typeof sandbox.health === 'function') {
      const raw = await sandbox.health();
      if (raw && raw.status && raw.status !== 'ok') {
        throw new DesktopProviderError('El escritorio E2B no está sano.', {
          code: 'desktop_e2b_unhealthy',
          status: 503,
        });
      }
    }
    return { status: 'ok', display: String((sandbox.display || (handle && handle.display) || ':0')) };
  }

  async screenshot(handle) {
    const sandbox = this._sandboxOf(handle);
    if (typeof sandbox.screenshot !== 'function') {
      throw new DesktopProviderError('El cliente E2B no expone screenshot().', {
        code: 'desktop_e2b_screenshot_unsupported',
        status: 501,
      });
    }
    const raw = await sandbox.screenshot();
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw || []);
    const mediaType = sniffMediaType(bytes);
    return { bytes, mediaType };
  }

  _sandboxOf(handle) {
    const id = handle && handle.id;
    if (!id) {
      throw new DesktopProviderError('health()/screenshot() necesita un handle de escritorio.', {
        code: 'desktop_handle_required',
        status: 400,
      });
    }
    const sandbox = this._sandboxes.get(String(id)) || (handle && handle._sandbox);
    if (!sandbox) {
      throw new DesktopProviderError('No hay un sandbox E2B para este handle.', {
        code: 'desktop_handle_unknown',
        status: 404,
      });
    }
    return sandbox;
  }

  _readWsUrl(sandbox) {
    if (!sandbox) return '';
    if (typeof sandbox.wsUrl === 'string') return sandbox.wsUrl;
    const stream = sandbox.stream;
    if (stream && typeof stream.getUrl === 'function') {
      try {
        const url = stream.getUrl();
        return typeof url === 'string' ? url : '';
      } catch (_) {
        return '';
      }
    }
    if (stream && typeof stream.url === 'string') return stream.url;
    return '';
  }
}

assertImplementsDesktopProvider(E2BDesktopProvider.prototype);

module.exports = {
  E2BDesktopProvider,
  loadE2BDesktopSdk,
  hasUsableKey,
};
