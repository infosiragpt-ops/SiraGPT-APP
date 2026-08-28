'use strict';

/**
 * E2BDesktopProvider — F7.0 STUB.
 *
 * Hybrid DesktopProvider plan: E2B is the future cloud backend (warm
 * pool + SDK in F7.1). This file exists so callers can depend on the
 * interface now without coupling to `@e2b/*`. There is NO E2B SDK
 * require, no API key read, and no network call.
 */

const {
  DesktopProvider,
  DesktopProviderError,
  assertImplementsDesktopProvider,
} = require('./DesktopProvider');

const NOT_YET = 'E2BDesktopProvider is a stub in F7.0 — SDK + warm pool arrive in F7.1';

class E2BDesktopProvider extends DesktopProvider {
  constructor(opts = {}) {
    super();
    this.kind = 'e2b';
    this.opts = opts;
  }

  async create() {
    throw new DesktopProviderError(NOT_YET, { code: 'F7_1_NOT_IMPLEMENTED', status: 501 });
  }

  async destroy() {
    throw new DesktopProviderError(NOT_YET, { code: 'F7_1_NOT_IMPLEMENTED', status: 501 });
  }

  async health() {
    throw new DesktopProviderError(NOT_YET, { code: 'F7_1_NOT_IMPLEMENTED', status: 501 });
  }

  async screenshot() {
    throw new DesktopProviderError(NOT_YET, { code: 'F7_1_NOT_IMPLEMENTED', status: 501 });
  }
}

assertImplementsDesktopProvider(E2BDesktopProvider.prototype);

module.exports = {
  E2BDesktopProvider,
};
