'use strict';

/**
 * Serializable harness-run snapshot (Phase 4c).
 *
 * Redis / memory store hold JSON only. AbortController, llmTurn and
 * permissionPolicy stay off the wire — the worker rehydrates them.
 * Session file bytes stay in the coding-sandbox jail, not here.
 */

const { getGrants } = require('../permissions');
const { publicRun } = require('../store');

const SNAPSHOT_VERSION = 1;

function cloneJson(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function serializePause(pause) {
  if (!pause || typeof pause !== 'object') return null;
  return {
    transcript: cloneJson(pause.transcript) || [],
    assistantText: typeof pause.assistantText === 'string' ? pause.assistantText : '',
    step: Number.isFinite(pause.step) ? pause.step : 0,
    currentCall: cloneJson(pause.currentCall) || null,
    remainingCalls: Array.isArray(pause.remainingCalls) ? cloneJson(pause.remainingCalls) : [],
  };
}

function serializeRun(row, extras = {}) {
  if (!row || typeof row !== 'object') return null;
  const grants = extras.grants
    || (extras.raw ? Array.from(getGrants(extras.raw)) : []);
  return {
    version: SNAPSHOT_VERSION,
    id: String(row.id || ''),
    sessionId: String(extras.sessionId || row.sessionId || ''),
    status: String(row.status || 'running'),
    prompt: String(row.prompt || ''),
    steps: Array.isArray(row.steps) ? cloneJson(row.steps) : [],
    text: typeof row.text === 'string' ? row.text : '',
    tokensEstimate: Number(row.tokensEstimate) || 0,
    createdAt: Number(row.createdAt) || Date.now(),
    finishedAt: row.finishedAt == null ? null : Number(row.finishedAt),
    error: row.error ? cloneJson(row.error) : null,
    caps: row.caps ? {
      maxSteps: row.caps.maxSteps,
      maxTokens: row.caps.maxTokens,
      timeoutMs: row.caps.timeoutMs,
    } : null,
    permissions: Array.isArray(row.permissions) ? cloneJson(row.permissions) : [],
    grants: Array.isArray(grants) ? grants.map(String) : [],
    pause: serializePause(row.pause),
    cancelRequested: Boolean(row.cancelRequested),
    modelAlias: row.modelAlias ? String(row.modelAlias) : '',
  };
}

function hydrateRun(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const id = String(snapshot.id || '').trim();
  if (!id) return null;
  return {
    id,
    sessionId: String(snapshot.sessionId || ''),
    status: String(snapshot.status || 'running'),
    prompt: String(snapshot.prompt || ''),
    steps: Array.isArray(snapshot.steps) ? cloneJson(snapshot.steps) : [],
    text: typeof snapshot.text === 'string' ? snapshot.text : '',
    tokensEstimate: Number(snapshot.tokensEstimate) || 0,
    createdAt: Number(snapshot.createdAt) || Date.now(),
    finishedAt: snapshot.finishedAt == null ? null : Number(snapshot.finishedAt),
    error: snapshot.error ? cloneJson(snapshot.error) : null,
    caps: snapshot.caps ? { ...snapshot.caps } : null,
    permissions: Array.isArray(snapshot.permissions) ? cloneJson(snapshot.permissions) : [],
    pause: serializePause(snapshot.pause),
    abort: new AbortController(),
    timedOut: false,
    cancelRequested: Boolean(snapshot.cancelRequested),
    grants: Array.isArray(snapshot.grants) ? snapshot.grants.map(String) : [],
    modelAlias: snapshot.modelAlias ? String(snapshot.modelAlias) : '',
  };
}

function publicFromSnapshot(snapshot) {
  const row = hydrateRun(snapshot);
  if (!row) return null;
  return publicRun(row);
}

module.exports = {
  SNAPSHOT_VERSION,
  serializePause,
  serializeRun,
  hydrateRun,
  publicFromSnapshot,
};
