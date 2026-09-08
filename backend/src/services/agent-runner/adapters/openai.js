'use strict';

/**
 * OpenAI computer-use (CUA / Responses) → SiraAction[] (F7.3).
 *
 * Accepts `{ type, x, y, button, text, keys, path, scroll_x, scroll_y }`.
 */

const {
  normalizeSiraAction,
  normalizeSiraActions,
  isSiraActionType,
} = require('./sira-action');

const OPENAI_MAP = Object.freeze({
  screenshot: 'screenshot',
  click: 'click',
  double_click: 'double_click',
  scroll: 'scroll',
  type: 'type',
  wait: 'wait',
  keypress: 'key',
  key: 'key',
  drag: 'drag',
  move: 'move',
  hover: 'move',
});

function openaiOne(raw, opts = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const verb = String(raw.type || raw.action || '').trim().toLowerCase();
  if (verb === 'done' || verb === 'request_handoff') {
    return normalizeSiraAction({ type: verb, ...raw }, opts);
  }
  if (isSiraActionType(verb) && verb !== 'key') {
    return normalizeSiraAction(raw, opts);
  }
  const mapped = OPENAI_MAP[verb];
  if (!mapped) return null;

  if (mapped === 'key') {
    const keys = Array.isArray(raw.keys) ? raw.keys.join('+') : (raw.key || raw.text || '');
    return normalizeSiraAction({ type: 'key', key: keys }, opts);
  }
  if (mapped === 'drag') {
    return normalizeSiraAction({
      type: 'drag',
      path: raw.path,
      from: raw.from,
      to: raw.to,
      x1: raw.x1,
      y1: raw.y1,
      x2: raw.x2,
      y2: raw.y2,
    }, opts);
  }
  if (mapped === 'scroll') {
    return normalizeSiraAction({
      type: 'scroll',
      x: raw.x,
      y: raw.y,
      scrollX: raw.scroll_x ?? raw.scrollX,
      scrollY: raw.scroll_y ?? raw.scrollY,
      dy: raw.dy,
      direction: raw.direction,
    }, opts);
  }
  return normalizeSiraAction({
    type: mapped,
    x: raw.x,
    y: raw.y,
    button: raw.button,
    text: raw.text,
    duration: raw.duration,
    ms: raw.ms,
  }, opts);
}

function openaiToSira(raw, opts = {}) {
  const list = Array.isArray(raw)
    ? raw
    : raw && Array.isArray(raw.actions)
      ? raw.actions
      : raw && (raw.type || raw.action)
        ? [raw]
        : [];
  const out = [];
  for (const item of list) {
    const action = openaiOne(item, opts);
    if (action) out.push(action);
  }
  if (!out.length) return normalizeSiraActions(raw, opts);
  return out;
}

module.exports = { openaiToSira };
