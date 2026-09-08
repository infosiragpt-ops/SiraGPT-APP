'use strict';

/**
 * Frame protocol for the AGENTES_CODING_V2 terminal channel (PTY stub).
 *
 * JSON frames in both directions. SSE uses `event: <type>` + `data: <json>`.
 * xterm.js can consume stdout/stderr `data` as raw bytes later; this PR
 * is API-only (UI-lock). Pattern from xtermjs/xterm.js — no npm dep.
 */

const CLIENT_TYPES = Object.freeze(['attach', 'input', 'resize', 'exec', 'signal', 'close']);
const SERVER_TYPES = Object.freeze(['ready', 'stdout', 'stderr', 'exit', 'error', 'closed']);
const SIGNALS = Object.freeze(['SIGINT', 'SIGTERM']);

const CLIENT_SET = new Set(CLIENT_TYPES);
const SERVER_SET = new Set(SERVER_TYPES);

function asObject(raw) {
  if (raw && typeof raw === 'object' && !Buffer.isBuffer(raw)) return raw;
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function decodeFrame(raw, { role = 'client' } = {}) {
  const obj = asObject(raw);
  if (!obj || typeof obj.type !== 'string') {
    const err = new Error('Marco de terminal inválido.');
    err.code = 'E_PARAMS';
    throw err;
  }
  const allowed = role === 'server' ? SERVER_SET : CLIENT_SET;
  if (!allowed.has(obj.type)) {
    const err = new Error('Tipo de marco de terminal no soportado.');
    err.code = 'E_PARAMS';
    throw err;
  }
  return obj;
}

function encodeFrame(frame) {
  if (!frame || typeof frame.type !== 'string') {
    const err = new Error('Marco de terminal inválido.');
    err.code = 'E_PARAMS';
    throw err;
  }
  return JSON.stringify(frame);
}

function encodeSse(frame) {
  const type = frame && frame.type ? String(frame.type) : 'message';
  return `event: ${type}\ndata: ${encodeFrame(frame)}\n\n`;
}

function queryFromUrl(rawUrl) {
  const text = String(rawUrl || '');
  const q = text.includes('?') ? text.slice(text.indexOf('?') + 1) : '';
  return new URLSearchParams(q);
}

function readBearerOrToken(request) {
  const header = request && request.headers
    ? (request.headers.authorization || request.headers.Authorization || '')
    : '';
  const bearer = String(header).match(/^Bearer\s+(\S+)/i);
  if (bearer) return bearer[1];
  const params = queryFromUrl(request && request.url);
  const token = params.get('token');
  return token ? String(token) : '';
}

module.exports = {
  CLIENT_TYPES,
  SERVER_TYPES,
  SIGNALS,
  decodeFrame,
  encodeFrame,
  encodeSse,
  queryFromUrl,
  readBearerOrToken,
};
