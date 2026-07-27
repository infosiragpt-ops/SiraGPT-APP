'use strict';

const {
  AGENT_CAPABILITIES_SCHEMA_VERSION,
  assertAgentExecutionContext,
  assertAgentOutcome,
  assertAgentRequest,
} = require('./contract');

const ADAPTER_ID = 'remote-http';
const ADAPTER_VERSION = '1.0.0';
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

class RemoteAgentConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RemoteAgentConfigurationError';
    this.code = 'CODEX_REMOTE_AGENT_CONFIG_INVALID';
  }
}

function isLoopback(hostname) {
  return ['localhost', '127.0.0.1', '::1'].includes(String(hostname || '').toLowerCase());
}

function resolveRemoteAgentConfig(env = process.env) {
  const rawUrl = String(env.CODEX_REMOTE_AGENT_URL || '').trim();
  const token = String(env.CODEX_REMOTE_AGENT_TOKEN || '').trim();
  if (!rawUrl) throw new RemoteAgentConfigurationError('CODEX_REMOTE_AGENT_URL is required for remote-http');
  if (!token) throw new RemoteAgentConfigurationError('CODEX_REMOTE_AGENT_TOKEN is required for remote-http');

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new RemoteAgentConfigurationError('CODEX_REMOTE_AGENT_URL must be a valid URL');
  }
  const localDevelopment = env.NODE_ENV !== 'production' && url.protocol === 'http:' && isLoopback(url.hostname);
  if (url.protocol !== 'https:' && !localDevelopment) {
    throw new RemoteAgentConfigurationError('CODEX_REMOTE_AGENT_URL must use HTTPS outside local development');
  }
  if (url.username || url.password || url.hash) {
    throw new RemoteAgentConfigurationError('CODEX_REMOTE_AGENT_URL cannot contain credentials or a fragment');
  }

  const configuredTimeout = Number.parseInt(env.CODEX_REMOTE_AGENT_TIMEOUT_MS || '', 10);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout >= 1_000
    ? Math.min(configuredTimeout, 60 * 60_000)
    : DEFAULT_TIMEOUT_MS;
  return Object.freeze({ url: url.toString(), token, timeoutMs });
}

function remoteAgentEnv(env = process.env) {
  return Object.freeze({
    NODE_ENV: env.NODE_ENV,
    CODEX_REMOTE_AGENT_URL: env.CODEX_REMOTE_AGENT_URL,
    CODEX_REMOTE_AGENT_TOKEN: env.CODEX_REMOTE_AGENT_TOKEN,
    CODEX_REMOTE_AGENT_TIMEOUT_MS: env.CODEX_REMOTE_AGENT_TIMEOUT_MS,
  });
}

function createRemoteHttpAdapter({
  fetchImpl = (...args) => fetch(...args),
  defaultEnv = process.env,
} = {}) {
  return Object.freeze({
    id: ADAPTER_ID,
    version: ADAPTER_VERSION,

    capabilities() {
      return Object.freeze({
        schemaVersion: AGENT_CAPABILITIES_SCHEMA_VERSION,
        roles: Object.freeze(['implementer']),
        modes: Object.freeze(['plan', 'build']),
        workspaceAccess: 'rw',
      });
    },

    health({ env = defaultEnv } = {}) {
      try {
        const config = resolveRemoteAgentConfig(env);
        return {
          ok: true,
          configured: true,
          status: 'ready',
          adapter: ADAPTER_ID,
          version: ADAPTER_VERSION,
          endpoint: new URL(config.url).origin,
        };
      } catch (error) {
        return {
          ok: false,
          configured: false,
          status: 'misconfigured',
          adapter: ADAPTER_ID,
          version: ADAPTER_VERSION,
          error: String(error?.message || error),
        };
      }
    },

    async execute(request, context = {}) {
      assertAgentRequest(request, { expectedRole: 'implementer' });
      assertAgentExecutionContext(context);
      if (await context.isCancelled?.()) return { status: 'cancelled' };

      const config = resolveRemoteAgentConfig(context.deps?.env || defaultEnv);
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (context.signal?.aborted) abort();
      else context.signal?.addEventListener('abort', abort, { once: true });
      const deadlineMs = Math.min(config.timeoutMs, request.budget.timeoutMs);
      const timer = setTimeout(abort, deadlineMs);
      if (typeof timer.unref === 'function') timer.unref();

      try {
        const response = await fetchImpl(config.url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.token}`,
            'Content-Type': 'application/json',
            'X-Sira-Agent-Schema': request.schemaVersion,
          },
          body: JSON.stringify(request),
          signal: controller.signal,
        });
        const declaredLength = Number.parseInt(response.headers?.get?.('content-length') || '0', 10);
        if (declaredLength > MAX_RESPONSE_BYTES) {
          throw new Error('remote agent response exceeds the 1 MiB contract limit');
        }
        const text = await response.text();
        if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
          throw new Error('remote agent response exceeds the 1 MiB contract limit');
        }
        if (!response.ok) {
          throw new Error(`remote agent HTTP ${response.status}`);
        }
        let outcome;
        try {
          outcome = JSON.parse(text);
        } catch {
          throw new Error('remote agent returned invalid JSON');
        }
        if (await context.isCancelled?.()) return { status: 'cancelled' };
        return assertAgentOutcome(outcome);
      } catch (error) {
        if (context.signal?.aborted || await context.isCancelled?.()) return { status: 'cancelled' };
        if (controller.signal.aborted) {
          throw new Error(`remote agent exceeded ${deadlineMs}ms timeout`);
        }
        throw error;
      } finally {
        clearTimeout(timer);
        context.signal?.removeEventListener?.('abort', abort);
      }
    },
  });
}

const remoteHttpAdapter = createRemoteHttpAdapter();

module.exports = {
  ADAPTER_ID,
  ADAPTER_VERSION,
  MAX_RESPONSE_BYTES,
  RemoteAgentConfigurationError,
  createRemoteHttpAdapter,
  remoteAgentEnv,
  remoteHttpAdapter,
  resolveRemoteAgentConfig,
};
