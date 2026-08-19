'use strict';

// GPT Actions — let a custom GPT call creator-defined external HTTP APIs as
// agent tools (ChatGPT-style "Actions"). This module owns three concerns:
//
//   1. Validation/normalisation of an action definition (the shape persisted
//      in CustomGpt.actions JSON).
//   2. Secure persistence helpers: encrypt the creator's auth secret at rest,
//      preserve it across edits (merge-by-id), and NEVER leak it to the client.
//   3. A SSRF-hardened executor + agent-tool builder so the chat agent can
//      invoke the action during a turn.
//
// SSRF posture mirrors the agent-harness web_fetch tool (deny-by-class): we
// reuse `assertSafeUrl` (scheme / credentials / blocked-hostname / private-IP
// literal checks) and `resolveAndAssertSafe` (DNS anti-rebinding), and follow
// redirects MANUALLY, re-validating every hop. There is no allowlist — an
// action may target any *public* https host, never a private/loopback/metadata
// address. encryption.js is required LAZILY because it process.exit(1)s when
// ENCRYPTION_KEY is unset, which must not happen at import time.

const net = require('net');
const crypto = require('crypto');
const { assertSafeUrl } = require('../agent-harness/tools/web-fetch-tool');
const { resolveAndAssertSafe } = require('../connectors/web-fetch');

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const ALLOWED_PARAM_TYPES = new Set(['string', 'number', 'boolean']);
const ALLOWED_PARAM_LOCATIONS = new Set(['query', 'path', 'body']);
const ALLOWED_AUTH_TYPES = new Set(['none', 'api_key', 'bearer']);
// Names that would collide with control tools added later in the agent loop
// (e.g. react-agent's `finalize`). An action may never claim one of these.
const RESERVED_TOOL_NAMES = new Set(['finalize', 'final_answer', 'multi_tool_use', 'parallel']);

const MAX_ACTIONS_PER_GPT = clampInt(process.env.SIRAGPT_GPT_ACTIONS_MAX, 16, 1, 64);
const MAX_PARAMS_PER_ACTION = 24;
const ACTION_TIMEOUT_MS = clampInt(process.env.SIRAGPT_GPT_ACTION_TIMEOUT_MS, 20000, 1000, 60000);
const ACTION_MAX_RESPONSE_CHARS = clampInt(process.env.SIRAGPT_GPT_ACTION_MAX_RESPONSE_CHARS, 8000, 500, 50000);
const ACTION_MAX_BODY_BYTES = 1 * 1024 * 1024; // raw read cap
const ACTION_MAX_REDIRECTS = 3;
const NAME_MAX = 48;
const DESC_MAX = 600;
const URL_MAX = 2000;

function clampInt(raw, fallback, min, max) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Tool-safe function name: lowercase, [a-z0-9_], collapse, bounded, leading alpha.
function sanitizeActionName(raw) {
  let name = String(raw || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, NAME_MAX);
  if (!name) name = '';
  // OpenAI function names must start with a letter or underscore.
  if (name && /^[0-9]/.test(name)) name = `a_${name}`.slice(0, NAME_MAX);
  return name;
}

function cleanStr(value, max) {
  return String(value == null ? '' : value)
    .replace(/\u0000/g, '')
    .trim()
    .slice(0, max);
}

// Validate + normalise ONE action definition. Returns { ok, errors, normalized }.
// `normalized` is the canonical storage shape (minus the encrypted secret,
// which is applied by normalizeActionsForStore). Never throws.
function validateActionDefinition(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') {
    return { ok: false, errors: ['action must be an object'], normalized: null };
  }

  const name = sanitizeActionName(raw.name);
  if (!name) errors.push('name is required (letters/numbers/underscore)');
  else if (RESERVED_TOOL_NAMES.has(name)) errors.push(`name "${name}" is reserved`);

  const description = cleanStr(raw.description, DESC_MAX);
  if (!description) errors.push('description is required');

  const method = String(raw.method || 'GET').toUpperCase();
  if (!ALLOWED_METHODS.has(method)) errors.push(`method must be one of ${[...ALLOWED_METHODS].join(', ')}`);

  const url = cleanStr(raw.url, URL_MAX);
  if (!url) {
    errors.push('url is required');
  } else {
    try {
      assertSafeUrl(url); // scheme/host/private-IP guard (also rejects http://localhost etc.)
    } catch (e) {
      errors.push(`url is not a safe public https URL: ${e && e.message ? e.message : 'invalid'}`);
    }
  }

  const params = [];
  const rawParams = Array.isArray(raw.params) ? raw.params.slice(0, MAX_PARAMS_PER_ACTION) : [];
  const seenParam = new Set();
  for (const p of rawParams) {
    if (!p || typeof p !== 'object') continue;
    const pname = cleanStr(p.name, 64).replace(/[^A-Za-z0-9_]/g, '');
    if (!pname || seenParam.has(pname)) continue;
    seenParam.add(pname);
    const ptype = ALLOWED_PARAM_TYPES.has(p.type) ? p.type : 'string';
    const pin = ALLOWED_PARAM_LOCATIONS.has(p.in) ? p.in : 'query';
    params.push({
      name: pname,
      in: pin,
      type: ptype,
      required: p.required === true,
      description: cleanStr(p.description, 200),
    });
  }

  // Every {placeholder} in the URL must be backed by a path param.
  if (url) {
    const placeholders = [...url.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]);
    for (const ph of placeholders) {
      if (!params.some((p) => p.in === 'path' && p.name === ph)) {
        errors.push(`url placeholder {${ph}} has no matching path param`);
      }
    }
  }

  // Auth (the secret itself is handled by normalizeActionsForStore).
  let auth = { type: 'none' };
  if (raw.auth && typeof raw.auth === 'object') {
    const atype = ALLOWED_AUTH_TYPES.has(raw.auth.type) ? raw.auth.type : 'none';
    if (atype === 'api_key') {
      auth = {
        type: 'api_key',
        in: raw.auth.in === 'query' ? 'query' : 'header',
        name: cleanStr(raw.auth.name, 64).replace(/[^A-Za-z0-9_-]/g, '') || 'X-API-Key',
      };
    } else if (atype === 'bearer') {
      auth = { type: 'bearer' };
    }
  }

  if (errors.length) return { ok: false, errors, normalized: null };

  return {
    ok: true,
    errors: [],
    normalized: { id: cleanStr(raw.id, 64) || null, name, description, method, url, params, auth },
  };
}

// ── Persistence helpers ─────────────────────────────────────────────────────

function lazyEncryption() {
  // Required lazily: encryption.js exits the process if ENCRYPTION_KEY is unset.
  return require('../../utils/encryption');
}

// Build the canonical array to persist in CustomGpt.actions. Encrypts any NEW
// plaintext secret (raw.auth.secret); for an existing action (matched by id)
// with no new secret, carries the prior encryptedValue forward so editing the
// GPT never wipes its credentials. Plaintext secrets are NEVER stored. Invalid
// actions are dropped. Capped at MAX_ACTIONS_PER_GPT.
function normalizeActionsForStore(incoming, existing = []) {
  const existingById = new Map();
  for (const a of Array.isArray(existing) ? existing : []) {
    if (a && a.id) existingById.set(a.id, a);
  }

  const out = [];
  const list = Array.isArray(incoming) ? incoming : [];
  for (const raw of list) {
    if (out.length >= MAX_ACTIONS_PER_GPT) break;
    const v = validateActionDefinition(raw);
    if (!v.ok) continue;
    const action = v.normalized;

    // Stable id: reuse a known id, else mint one.
    const providedId = action.id;
    const id = providedId && existingById.has(providedId) ? providedId : crypto.randomUUID();
    action.id = id;

    if (action.auth && (action.auth.type === 'api_key' || action.auth.type === 'bearer')) {
      const plaintext =
        raw.auth && typeof raw.auth.secret === 'string' ? raw.auth.secret.trim() : '';
      if (plaintext) {
        action.auth.encryptedValue = lazyEncryption().encrypt(plaintext);
      } else {
        const prior = existingById.get(id);
        if (prior && prior.auth && prior.auth.encryptedValue) {
          action.auth.encryptedValue = prior.auth.encryptedValue;
        }
      }
    }
    out.push(action);
  }
  return out;
}

// Strip secrets before sending actions to the client. Replaces auth.encryptedValue
// with a boolean `hasSecret` so the UI can show "key set" without ever seeing it.
function redactActionsForClient(actions) {
  const list = Array.isArray(actions) ? actions : [];
  return list.map((a) => {
    if (!a || typeof a !== 'object') return a;
    const copy = { ...a };
    if (copy.auth && typeof copy.auth === 'object') {
      const hasSecret = !!copy.auth.encryptedValue;
      const { encryptedValue, secret, ...rest } = copy.auth; // eslint-disable-line no-unused-vars
      copy.auth = { ...rest, hasSecret };
    }
    return copy;
  });
}

// ── Executor + tool builder ─────────────────────────────────────────────────

function buildParametersSchema(action) {
  const properties = {};
  const required = [];
  for (const p of action.params) {
    properties[p.name] = { type: p.type };
    if (p.description) properties[p.name].description = p.description;
    if (p.required) required.push(p.name);
  }
  const schema = { type: 'object', properties, additionalProperties: false };
  if (required.length) schema.required = required;
  return schema;
}

function decryptSecretQuiet(encryptedValue) {
  if (!encryptedValue) return null;
  try {
    return lazyEncryption().decrypt(encryptedValue);
  } catch (_) {
    return null;
  }
}

function applyAuth(auth, parsedUrl, headers) {
  if (!auth || auth.type === 'none' || !auth.type) return;
  const secret = decryptSecretQuiet(auth.encryptedValue);
  if (!secret) return; // no/undecryptable secret → send unauthenticated
  if (auth.type === 'bearer') {
    headers['Authorization'] = `Bearer ${secret}`;
  } else if (auth.type === 'api_key') {
    if (auth.in === 'query') parsedUrl.searchParams.append(auth.name || 'api_key', secret);
    else headers[auth.name || 'X-API-Key'] = secret;
  }
}

async function assertDnsSafe(parsedUrl, lookup) {
  const host = parsedUrl.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return; // literal already vetted by assertSafeUrl
  await resolveAndAssertSafe(host, lookup); // throws WebFetchError if any A/AAAA is private
}

async function readCappedText(response) {
  const reader = response.body && response.body.getReader ? response.body.getReader() : null;
  if (!reader) {
    const t = await response.text();
    return t.slice(0, ACTION_MAX_BODY_BYTES);
  }
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let out = '';
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = ACTION_MAX_BODY_BYTES - bytes;
      if (value.byteLength >= remaining) {
        out += decoder.decode(value.subarray(0, remaining), { stream: false });
        break;
      }
      out += decoder.decode(value, { stream: true });
      bytes += value.byteLength;
    }
  } finally {
    // Release the stream on every exit path (done, truncation, mid-read
    // throw) — previously only truncation cancelled, leaking the socket
    // on normal completion.
    try { reader.cancel(); } catch (_) { /* ignore */ }
  }
  return out;
}

// Execute one action with the model-supplied args. SSRF-hardened. Returns a
// plain, JSON-serialisable object the agent loop feeds back to the model.
async function executeActionRequest(action, args, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const argv = args && typeof args === 'object' ? args : {};
  const params = Array.isArray(action.params) ? action.params : [];

  // 1. Path params → substitute {name}; then URL-safety check.
  let urlStr = action.url;
  for (const p of params) {
    if (p.in !== 'path') continue;
    const v = argv[p.name];
    if (v == null || v === '') {
      if (p.required) throw new Error(`missing required path parameter "${p.name}"`);
      continue;
    }
    urlStr = urlStr.replace(new RegExp(`\\{${escapeRegExp(p.name)}\\}`, 'g'), encodeURIComponent(String(v)));
  }
  let parsed = assertSafeUrl(urlStr);

  // 2. Query params.
  for (const p of params) {
    if (p.in !== 'query') continue;
    const v = argv[p.name];
    if (v == null || v === '') {
      if (p.required) throw new Error(`missing required query parameter "${p.name}"`);
      continue;
    }
    parsed.searchParams.append(p.name, String(v));
  }

  // 3. Headers + auth + body.
  let headers = {
    'User-Agent': 'SiraGPT-GPT-Action/1.0',
    Accept: 'application/json, text/plain;q=0.9, */*;q=0.5',
  };
  const baseHeaderKeys = new Set(Object.keys(headers));
  applyAuth(action.auth, parsed, headers);
  // Header names applyAuth added (Authorization / a configured api_key header) —
  // these carry the user's secret and must NOT follow a cross-origin redirect,
  // or an attacker-controlled 30x could exfiltrate the credential.
  const authHeaderKeys = Object.keys(headers).filter((k) => !baseHeaderKeys.has(k));
  const originalOrigin = parsed.origin;

  let body;
  if (action.method !== 'GET' && action.method !== 'DELETE') {
    const bodyObj = {};
    for (const p of params) {
      if (p.in !== 'body') continue;
      const v = argv[p.name];
      if (v == null) {
        if (p.required) throw new Error(`missing required body parameter "${p.name}"`);
        continue;
      }
      bodyObj[p.name] = v;
    }
    if (Object.keys(bodyObj).length) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(bodyObj);
    }
  }

  // 4. Fetch with timeout + manual, re-validated redirects.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ACTION_TIMEOUT_MS);
  try {
    let current = parsed;
    for (let hop = 0; hop <= ACTION_MAX_REDIRECTS; hop++) {
      await assertDnsSafe(current, options.lookup);
      const res = await fetchImpl(current.toString(), {
        method: action.method,
        headers,
        body,
        redirect: 'manual',
        signal: controller.signal,
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) throw new Error(`redirect (${res.status}) without Location header`);
        if (hop === ACTION_MAX_REDIRECTS) throw new Error('too many redirects');
        const next = assertSafeUrl(new URL(location, current).toString());
        // Strip the auth secret before following a redirect to a different
        // origin (scheme+host+port) so it can't leak to an attacker host. Swap
        // in a fresh headers object so the already-sent request keeps its auth.
        if (next.origin !== originalOrigin && authHeaderKeys.length) {
          headers = { ...headers };
          for (const k of authHeaderKeys) delete headers[k];
        }
        current = next;
        continue;
      }

      const text = await readCappedText(res);
      const capped = text.length > ACTION_MAX_RESPONSE_CHARS;
      return {
        ok: res.ok,
        status: res.status,
        contentType: res.headers.get('content-type') || null,
        body: capped ? text.slice(0, ACTION_MAX_RESPONSE_CHARS) + '\n…[truncated]' : text,
        truncated: capped,
      };
    }
    throw new Error('too many redirects');
  } finally {
    clearTimeout(timer);
  }
}

// Build agent tools from a GPT's persisted actions. Each tool's execute() runs
// executeActionRequest and NEVER throws (errors become a structured result so
// the agent loop continues). Invalid actions are skipped.
function buildActionTools(actions, options = {}) {
  const tools = [];
  const list = Array.isArray(actions) ? actions : [];
  const seenNames = new Set();
  for (const raw of list) {
    const v = validateActionDefinition(raw);
    if (!v.ok) continue;
    // validateActionDefinition strips the encrypted secret; re-attach it so
    // execute() can authenticate. (The persisted `raw` carries it.)
    const action = v.normalized;
    if (raw.auth && raw.auth.encryptedValue && action.auth && action.auth.type !== 'none') {
      action.auth.encryptedValue = raw.auth.encryptedValue;
    }
    if (seenNames.has(action.name)) continue;
    seenNames.add(action.name);

    tools.push({
      name: action.name,
      description: action.description,
      parameters: buildParametersSchema(action),
      _gptAction: true,
      execute: async (toolArgs) => {
        try {
          return await executeActionRequest(action, toolArgs, options);
        } catch (e) {
          return {
            error: true,
            message: e && e.message ? String(e.message).slice(0, 300) : 'action_failed',
          };
        }
      },
    });
  }
  return tools;
}

module.exports = {
  validateActionDefinition,
  sanitizeActionName,
  normalizeActionsForStore,
  redactActionsForClient,
  buildParametersSchema,
  executeActionRequest,
  buildActionTools,
  MAX_ACTIONS_PER_GPT,
  ACTION_TIMEOUT_MS,
  ACTION_MAX_RESPONSE_CHARS,
};
