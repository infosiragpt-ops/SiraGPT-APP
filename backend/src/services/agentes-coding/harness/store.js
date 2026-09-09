'use strict';

/**
 * In-process harness run store (same pattern as export/deploy).
 * Lives on the coding-sandbox session raw object. No control DB.
 */

const crypto = require('node:crypto');
const { fail, CATALOG } = require('../coding-sandbox/errors');
const { listPending } = require('./permissions');

const MAX_RUNS = 16;
const MAX_PROMPT_CHARS = 16_384;
const ACTIVE_STATUSES = Object.freeze(['running', 'awaiting_permission']);

function getStore(raw) {
  if (!raw.harness) raw.harness = { items: [] };
  if (!Array.isArray(raw.harness.items)) raw.harness.items = [];
  return raw.harness;
}

function sanitizePrompt(value) {
  const prompt = String(value == null ? '' : value);
  if (!prompt.trim()) fail('E_PARAMS', 'Falta el prompt del turno.');
  if (prompt.length > MAX_PROMPT_CHARS) {
    fail('E_QUOTA', `El prompt supera ${MAX_PROMPT_CHARS} caracteres.`);
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(prompt)) {
    fail('E_PARAMS', 'El prompt contiene caracteres de control.');
  }
  return prompt;
}

function createRun(raw, prompt, caps) {
  const store = getStore(raw);
  if (store.items.some((row) => ACTIVE_STATUSES.includes(row.status))) {
    fail('E_QUOTA', 'Ya hay un turno del harness en curso.');
  }
  const controller = new AbortController();
  const row = {
    id: `hrn_${crypto.randomBytes(8).toString('hex')}`,
    status: 'running',
    prompt,
    steps: [],
    text: '',
    tokensEstimate: 0,
    createdAt: Date.now(),
    finishedAt: null,
    error: null,
    caps,
    abort: controller,
    timedOut: false,
    permissions: [],
    pause: null,
  };
  store.items.push(row);
  if (store.items.length > MAX_RUNS) store.items.splice(0, store.items.length - MAX_RUNS);
  return row;
}

function findRun(raw, runId) {
  const id = String(runId || '').trim();
  if (!id) fail('E_PARAMS', 'Falta el id de ejecución del harness.');
  const row = getStore(raw).items.find((item) => item.id === id);
  if (!row) fail('E_HARNESS_NOT_FOUND');
  return row;
}

function appendStep(row, kind, extra = {}) {
  const step = {
    seq: row.steps.length + 1,
    kind,
    ts: Date.now(),
    label: extra.label || kind,
  };
  if (extra.tool) step.tool = extra.tool;
  if (extra.args != null) step.args = extra.args;
  if (extra.ok != null) step.ok = extra.ok;
  if (extra.preview != null) step.preview = extra.preview;
  if (extra.code) step.code = extra.code;
  row.steps.push(step);
  return step;
}

function publicError(code, detail) {
  const entry = CATALOG[code] || CATALOG.E_HARNESS_FAILED;
  const message = detail ? `${entry.message} ${detail}`.trim() : entry.message;
  return { code: CATALOG[code] ? code : 'E_HARNESS_FAILED', message };
}

function finishRun(row, status, error) {
  row.status = status;
  row.finishedAt = Date.now();
  if (error) row.error = error;
}

function publicRun(row) {
  return {
    id: row.id,
    status: row.status,
    prompt: row.prompt,
    steps: row.steps.map((step) => ({ ...step })),
    text: row.text,
    tokensEstimate: row.tokensEstimate,
    durationMs: (row.finishedAt || Date.now()) - row.createdAt,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
    error: row.error,
    pendingPermissions: listPending(row),
    caps: row.caps ? {
      maxSteps: row.caps.maxSteps,
      maxTokens: row.caps.maxTokens,
      timeoutMs: row.caps.timeoutMs,
    } : undefined,
  };
}

function forget(sandbox, sessionId) {
  const raw = sandbox && typeof sandbox._unsafeGetRaw === 'function'
    ? sandbox._unsafeGetRaw(sessionId)
    : null;
  if (raw && raw.harness) raw.harness = { items: [], grants: new Set() };
}

module.exports = {
  MAX_RUNS,
  MAX_PROMPT_CHARS,
  ACTIVE_STATUSES,
  getStore,
  sanitizePrompt,
  createRun,
  findRun,
  appendStep,
  publicError,
  finishRun,
  publicRun,
  forget,
};
