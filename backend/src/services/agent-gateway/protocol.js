'use strict';

/**
 * SiraGPT Agent Gateway — wire protocol.
 * Ideas inspired by OpenClaw Gateway; this is an original rewrite (no source copied).
 *
 * Frames:
 *   req   { type:'req',   id, method, params }
 *   res   { type:'res',   id, ok, payload | error }
 *   event { type:'event', event, payload, seq }
 *
 * First frame on a connection MUST be method "connect".
 */

const METHODS = Object.freeze({
  CONNECT: 'connect',
  AGENT: 'agent',
  AGENT_WAIT: 'agent.wait',
  AGENT_ABORT: 'agent.abort',
  STATUS: 'status',
  SKILLS_LIST: 'skills.list',
  SKILLS_LOAD: 'skills.load',
  SKILLS_DELETE: 'skills.delete',
  SKILLS_PERSIST: 'skills.persist',
  MEMORY_SEARCH: 'memory.search',
  MEMORY_PERSIST: 'memory.persist',
  MEMORY_DELETE: 'memory.delete',
  CRON_LIST: 'cron.list',
  CRON_CREATE: 'cron.create',
  CRON_DELETE: 'cron.delete',
});

const METHOD_LIST = Object.freeze(Object.values(METHODS));

const EVENTS = Object.freeze({
  LIFECYCLE: 'lifecycle',
  ASSISTANT: 'assistant',
  TOOL: 'tool',
  CRON: 'cron',
  PRESENCE: 'presence',
});

const FRAME_TYPES = Object.freeze({ REQ: 'req', RES: 'res', EVENT: 'event' });

let _seq = 0;

function nextSeq() {
  _seq += 1;
  return _seq;
}

function resetSeqForTests() {
  _seq = 0;
  try { require('../agent-runner/engine-completion').resetSessionSeq(); } catch (_) {}
}

function nextSessionSeq(sessionKey) {
  try {
    return require('../agent-runner/engine-completion').nextSessionSeq(sessionKey);
  } catch (_) {
    return nextSeq();
  }
}

function encodeReq(id, method, params) {
  return {
    type: FRAME_TYPES.REQ,
    id: String(id),
    method: String(method),
    params: params && typeof params === 'object' ? params : {},
  };
}

function encodeRes(id, ok, payloadOrError) {
  const frame = { type: FRAME_TYPES.RES, id: String(id), ok: Boolean(ok) };
  if (ok) frame.payload = payloadOrError == null ? {} : payloadOrError;
  else frame.error = payloadOrError == null ? { message: 'Error desconocido' } : payloadOrError;
  return frame;
}

function encodeEvent(event, payload, seq, sessionKey) {
  const key = sessionKey || (payload && payload.sessionKey) || null;
  const n = seq == null
    ? (key ? nextSessionSeq(key) : nextSeq())
    : (key ? nextSessionSeq(key) : Number(seq));
  return {
    type: FRAME_TYPES.EVENT,
    event: String(event),
    payload: payload == null ? {} : payload,
    seq: n,
    id: n,
  };
}

function encode(frame) {
  if (!frame || typeof frame !== 'object') {
    throw new Error('Frame inválido: se esperaba un objeto');
  }
  return JSON.stringify(frame);
}

function decode(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      try {
        const { decodeGatewayFrame } = require('../agent-runner/engine-completion');
        const repaired = decodeGatewayFrame(raw);
        if (repaired.ok) obj = repaired.frame;
        else throw new Error('Frame inválido: JSON malformado');
      } catch (err) {
        if (err && /JSON malformado/.test(String(err.message))) throw err;
        throw new Error('Frame inválido: JSON malformado');
      }
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('Frame inválido: se esperaba un objeto');
  }
  if (!['req', 'res', 'event'].includes(obj.type)) {
    throw new Error(`Frame inválido: type "${obj.type}" no reconocido`);
  }
  if (obj.type === 'req' && (obj.id == null || !obj.method)) {
    throw new Error('Frame req requiere id y method');
  }
  if (obj.type === 'res' && (obj.id == null || typeof obj.ok !== 'boolean')) {
    throw new Error('Frame res requiere id y ok');
  }
  if (obj.type === 'event') {
    if (!obj.event) throw new Error('Frame event requiere event');
    if (obj.seq == null) obj.seq = nextSeq();
  }
  return obj;
}

/**
 * First frame on `conn` must be req/connect. Mutates conn.handshakeDone.
 */
function validateFirstFrame(conn, frame) {
  if (conn && conn.handshakeDone) return frame;
  const decoded = frame && frame.type ? frame : decode(frame);
  if (decoded.type !== 'req' || decoded.method !== METHODS.CONNECT) {
    const err = new Error('El primer frame de la conexión debe ser connect');
    err.code = 'handshake_required';
    throw err;
  }
  if (conn) conn.handshakeDone = true;
  return decoded;
}

function isKnownMethod(method) {
  return METHOD_LIST.includes(String(method));
}

const SIDE_EFFECT_METHODS = Object.freeze([
  METHODS.AGENT,
  METHODS.AGENT_ABORT,
  METHODS.SKILLS_DELETE,
  METHODS.SKILLS_PERSIST,
  METHODS.MEMORY_PERSIST,
  METHODS.MEMORY_DELETE,
  METHODS.CRON_CREATE,
  METHODS.CRON_DELETE,
]);

function encodeReqWithIdempotency(id, method, params, idempotencyKey) {
  const frame = encodeReq(id, method, params);
  if (idempotencyKey) {
    frame.params = { ...frame.params, idempotencyKey: String(idempotencyKey) };
  }
  return frame;
}

module.exports = {
  METHODS,
  METHOD_LIST,
  SIDE_EFFECT_METHODS,
  EVENTS,
  FRAME_TYPES,
  encodeReqWithIdempotency,
  nextSeq,
  nextSessionSeq,
  resetSeqForTests,
  encodeReq,
  encodeRes,
  encodeEvent,
  encode,
  decode,
  validateFirstFrame,
  isKnownMethod,
};
