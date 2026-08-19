'use strict';

/**
 * opencode-config — single source of truth for connecting to an OpenCode
 * server (https://opencode.ai, MIT). OpenCode runs the coding agent as an HTTP
 * server (`opencode serve`, default 127.0.0.1:4096, OpenAPI 3.1 at /doc) that
 * any client can drive. siraGPT integrates it as the *engine* behind the
 * /code workspace — we keep our own UI and adapt the wiring; we do not vendor
 * its TUI/desktop.
 *
 * Mirrors `ai/cerebras-client.js`: env-driven, fail-soft. When no server URL is
 * configured, `isOpencodeConfigured()` returns false so callers degrade
 * gracefully instead of throwing.
 *
 * Env (all optional):
 *   OPENCODE_SERVER_URL       — base URL of a running `opencode serve`
 *                               (e.g. http://127.0.0.1:4096). Presence of this
 *                               value is what *enables* the integration.
 *   OPENCODE_SERVER_USERNAME  — HTTP basic user (default "opencode").
 *   OPENCODE_SERVER_PASSWORD  — HTTP basic password (omit if the server runs
 *                               unauthenticated on localhost).
 *
 * Attribution: OpenCode is MIT-licensed (github.com/sst/opencode). Keep the
 * upstream notice when redistributing.
 */

const DEFAULT_USERNAME = 'opencode';

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function getOpencodeConfig({ env = process.env } = {}) {
  const rawUrl = cleanString(env.OPENCODE_SERVER_URL);
  const username = cleanString(env.OPENCODE_SERVER_USERNAME) || DEFAULT_USERNAME;
  const password = cleanString(env.OPENCODE_SERVER_PASSWORD);

  if (!rawUrl) {
    return { enabled: false, baseUrl: '', username, password: '', reason: 'no_server_url' };
  }

  let baseUrl;
  try {
    baseUrl = new URL(rawUrl).toString().replace(/\/+$/, '');
  } catch {
    return { enabled: false, baseUrl: rawUrl, username, password: '', reason: 'invalid_url' };
  }

  return { enabled: true, baseUrl, username, password, reason: 'ok' };
}

function isOpencodeConfigured({ env = process.env } = {}) {
  return getOpencodeConfig({ env }).enabled;
}

/**
 * The model the engine should use. OpenCode defaults to anthropic/claude-*,
 * which fails when that account has no credit; we steer it to a funded provider
 * the container already has keys for. Override via OPENCODE_MODEL_PROVIDER /
 * OPENCODE_MODEL_ID. Returns null to let the engine pick its own default.
 */
function getOpencodeModel({ env = process.env } = {}) {
  const providerID = cleanString(env.OPENCODE_MODEL_PROVIDER) || 'openai';
  const modelID = cleanString(env.OPENCODE_MODEL_ID) || 'gpt-4o-mini';
  if (!providerID || !modelID) return null;
  return { providerID, modelID };
}

/** Build the Authorization header value, or null when no password is set. */
function basicAuthHeader(config) {
  if (!config || !config.password) return null;
  const token = Buffer.from(`${config.username}:${config.password}`).toString('base64');
  return `Basic ${token}`;
}

module.exports = { getOpencodeConfig, isOpencodeConfigured, getOpencodeModel, basicAuthHeader, DEFAULT_USERNAME };
