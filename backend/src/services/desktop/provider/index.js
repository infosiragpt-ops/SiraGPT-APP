'use strict';

/**
 * DesktopProvider factory (F7.0 + F7.1).
 *
 * Model-agnostic: pick a backend by kind, never by LLM. The live
 * computer orchestrator (PR #484) stays in place — this factory does
 * not route traffic there.
 */

const {
  DesktopProvider,
  DesktopProviderError,
  DESKTOP_PROVIDER_METHODS,
  assertImplementsDesktopProvider,
} = require('./DesktopProvider');
const { E2BDesktopProvider } = require('./E2BDesktopProvider');
const { LocalGvisorDesktopProvider, buildDesktopRunArgs } = require('./LocalGvisorDesktopProvider');

function createDesktopProvider(kind = 'local-gvisor', opts = {}) {
  const k = String(kind || 'local-gvisor').trim().toLowerCase().replace(/_/g, '-');
  if (k === 'e2b') return new E2BDesktopProvider(opts);
  if (k === 'local-gvisor' || k === 'local' || k === 'gvisor') {
    return new LocalGvisorDesktopProvider(opts);
  }
  throw new DesktopProviderError(
    `DesktopProvider kind desconocido: "${kind}" (e2b | local-gvisor).`,
    { code: 'desktop_provider_unknown', status: 400 },
  );
}

module.exports = {
  DesktopProvider,
  DesktopProviderError,
  DESKTOP_PROVIDER_METHODS,
  assertImplementsDesktopProvider,
  E2BDesktopProvider,
  LocalGvisorDesktopProvider,
  buildDesktopRunArgs,
  createDesktopProvider,
};
