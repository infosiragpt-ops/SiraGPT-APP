'use strict';

const {
  AGENT_CAPABILITIES_SCHEMA_VERSION,
  assertAgentRequest,
  assertAgentExecutionContext,
} = require('./contract');

const CAPABILITIES = Object.freeze({
  schemaVersion: AGENT_CAPABILITIES_SCHEMA_VERSION,
  roles: Object.freeze(['implementer']),
  modes: Object.freeze(['plan', 'build']),
  workspaceAccess: 'rw',
});

/**
 * Behaviour-preserving adapter for the existing Codex V2 loop. It intentionally
 * returns exactly what runAgentLoop returns; lifecycle/result interpretation
 * remains in run-processor, where it lived before adapters existed.
 */
const nativeCodexAdapter = Object.freeze({
  id: 'native',
  version: '1.0.0',

  capabilities() {
    return CAPABILITIES;
  },

  health() {
    return { ok: true, status: 'ready', adapter: 'native', version: '1.0.0' };
  },

  execute(request, context = {}) {
    assertAgentRequest(request, { expectedRole: 'implementer' });
    assertAgentExecutionContext(context);
    const loop = context.runAgentLoop || ((args) => require('../agent-loop').runAgentLoop(args));
    return loop({
      // The native loop keeps its exact pre-adapter Prisma snapshots. Remote
      // adapters will serialize only the narrow, path-free request envelope.
      run: context.nativeRun || request.run,
      project: context.nativeProject !== undefined ? context.nativeProject : request.project,
      signal: context.signal,
      isCancelled: context.isCancelled,
      deps: context.deps,
    });
  },
});

module.exports = { nativeCodexAdapter, CAPABILITIES };
