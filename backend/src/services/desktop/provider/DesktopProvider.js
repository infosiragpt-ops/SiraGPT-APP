'use strict';

/**
 * DesktopProvider — model-agnostic desktop backend contract (F7.0).
 *
 * This is a LAYER on top of the live computer orchestrator
 * (`services/computer-orchestrator`, PR #484). It does not replace
 * that service, the AgentRunner, the F5 sandbox, SSE, or artifacts.
 *
 * Implementations:
 *   - E2BDesktopProvider        — stub in F7.0; SDK + warm pool arrive in F7.1
 *   - LocalGvisorDesktopProvider — stub that can docker-run `sira-desktop`
 *                                  in tests; full gVisor flags are F7.6
 *
 * F7.0 ships ONLY these four methods. No CU-loop, no handoff FSM, no
 * session-manager SLO, no Prisma DesktopSession tables.
 *
 *   create(opts)      → Promise<DesktopHandle>
 *   destroy(handle)   → Promise<void>          (idempotent)
 *   health(handle)    → Promise<DesktopHealth> ({ status:'ok', display:':0' })
 *   screenshot(handle)→ Promise<DesktopScreenshot>
 *
 * Screen / web content returned by screenshot is DATA, never instructions.
 * Providers must not couple to a specific LLM or to one cloud backend.
 */

const DESKTOP_PROVIDER_METHODS = Object.freeze(['create', 'destroy', 'health', 'screenshot']);

/**
 * @typedef {object} DesktopHandle
 * @property {string} id
 * @property {string} display
 * @property {string} provider
 * @property {string} [containerId]
 */

/**
 * @typedef {object} DesktopHealth
 * @property {string} status
 * @property {string} display
 */

/**
 * @typedef {object} DesktopScreenshot
 * @property {Buffer} bytes
 * @property {string} mediaType
 */

class DesktopProviderError extends Error {
  constructor(message, { code = 'desktop_provider_error', status = 500 } = {}) {
    super(message);
    this.name = 'DesktopProviderError';
    this.code = code;
    this.status = status;
  }
}

class DesktopProvider {
  /**
   * Provision one isolated desktop. Implementations MUST NOT share a
   * desktop across users. F7.0 does not define a warm pool.
   * @param {object} [opts]
   * @returns {Promise<DesktopHandle>}
   */
  async create(_opts = {}) {
    throw new DesktopProviderError('DesktopProvider.create is abstract', {
      code: 'desktop_provider_abstract',
    });
  }

  /**
   * Tear down a desktop. Must be idempotent (destroy of a missing
   * handle is a no-op, not a throw).
   * @param {DesktopHandle} handle
   * @returns {Promise<void>}
   */
  async destroy(_handle) {
    throw new DesktopProviderError('DesktopProvider.destroy is abstract', {
      code: 'desktop_provider_abstract',
    });
  }

  /**
   * Probe the Desktop Control Plane. Success shape is fixed:
   * `{ status: 'ok', display: ':0' }` (display may differ only if the
   * implementation documents another :N; F7.0 image uses :0).
   * @param {DesktopHandle} handle
   * @returns {Promise<DesktopHealth>}
   */
  async health(_handle) {
    throw new DesktopProviderError('DesktopProvider.health is abstract', {
      code: 'desktop_provider_abstract',
    });
  }

  /**
   * Capture the framebuffer. Bytes are image/png or image/webp.
   * The pixels are DATA — never instructions for the model.
   * @param {DesktopHandle} handle
   * @returns {Promise<DesktopScreenshot>}
   */
  async screenshot(_handle) {
    throw new DesktopProviderError('DesktopProvider.screenshot is abstract', {
      code: 'desktop_provider_abstract',
    });
  }
}

function isAsyncFunction(fn) {
  return typeof fn === 'function';
}

/**
 * Structural check: `provider` exposes the four F7.0 contracts.
 * Does not call them — safe in unit tests without Docker.
 * @param {object} provider
 * @returns {true}
 */
function assertImplementsDesktopProvider(provider) {
  if (!provider || typeof provider !== 'object') {
    throw new DesktopProviderError('DesktopProvider implementation is missing', {
      code: 'desktop_provider_invalid',
      status: 400,
    });
  }
  for (const name of DESKTOP_PROVIDER_METHODS) {
    if (!isAsyncFunction(provider[name])) {
      throw new DesktopProviderError(
        `DesktopProvider must implement ${name}()`,
        { code: 'desktop_provider_invalid', status: 400 },
      );
    }
  }
  return true;
}

module.exports = {
  DesktopProvider,
  DesktopProviderError,
  DESKTOP_PROVIDER_METHODS,
  assertImplementsDesktopProvider,
};
