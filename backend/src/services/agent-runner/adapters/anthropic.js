'use strict';

/**
 * Anthropic computer-use → SiraAction[] (F7.3).
 *
 * Accepts computer_20241022 / computer_20250124 action objects
 * (`action`, `coordinate`, `text`, …). Output is vendor-neutral.
 */

const {
  normalizeSiraAction,
  normalizeSiraActions,
  scalePoint,
  clampPoint,
  DEFAULT_NATIVE,
  isSiraActionType,
} = require('./sira-action');

const ANTHROPIC_MAP = Object.freeze({
  screenshot: 'screenshot',
  left_click: 'click',
  right_click: 'click',
  middle_click: 'click',
  double_click: 'double_click',
  triple_click: 'double_click',
  mouse_move: 'move',
  left_click_drag: 'drag',
  type: 'type',
  key: 'key',
  scroll: 'scroll',
  wait: 'wait',
});

function buttonFor(action) {
  if (action === 'right_click') return 'right';
  if (action === 'middle_click') return 'middle';
  return 'left';
}

function coordPair(raw) {
  if (Array.isArray(raw) && raw.length >= 2) return { x: raw[0], y: raw[1] };
  if (raw && typeof raw === 'object' && ('x' in raw || 'y' in raw)) {
    return { x: raw.x, y: raw.y };
  }
  return null;
}

function anthropicOne(raw, opts = {}) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.type && !raw.action && isSiraActionType(raw.type)) {
    return normalizeSiraAction(raw, opts);
  }
  const verb = String(raw.action || raw.type || '').trim().toLowerCase();
  if (verb === 'done' || verb === 'request_handoff') {
    return normalizeSiraAction({ type: verb, ...raw }, opts);
  }
  const mapped = ANTHROPIC_MAP[verb];
  if (!mapped) return null;

  const image = opts.image;
  const native = opts.native || DEFAULT_NATIVE;
  const ptOf = (pair) => {
    if (!pair) return { x: 0, y: 0 };
    return image
      ? scalePoint(pair.x, pair.y, { image, native })
      : clampPoint(pair.x, pair.y, native);
  };

  if (mapped === 'screenshot' || mapped === 'wait' || mapped === 'type' || mapped === 'key') {
    return normalizeSiraAction({
      type: mapped,
      text: raw.text,
      key: raw.text,
      duration: raw.duration,
      ms: raw.duration_ms,
    }, opts);
  }

  const at = ptOf(coordPair(raw.coordinate) || { x: raw.x, y: raw.y });
  if (mapped === 'drag') {
    const start = ptOf(coordPair(raw.start_coordinate) || raw.start || { x: raw.x1, y: raw.y1 });
    return normalizeSiraAction({
      type: 'drag',
      from: start,
      to: at,
    }, { ...opts, image: null });
  }
  if (mapped === 'scroll') {
    const dir = String(raw.scroll_direction || raw.direction || '').toLowerCase();
    const amount = Number(raw.scroll_amount || raw.amount || 1) || 1;
    const dy = dir === 'up' ? -amount : dir === 'down' ? amount : amount;
    return normalizeSiraAction({
      type: 'scroll',
      x: at.x,
      y: at.y,
      dy,
      direction: dir,
    }, { ...opts, image: null });
  }
  return normalizeSiraAction({
    type: mapped,
    x: at.x,
    y: at.y,
    button: buttonFor(verb),
  }, { ...opts, image: null });
}

function anthropicToSira(raw, opts = {}) {
  const list = Array.isArray(raw)
    ? raw
    : raw && Array.isArray(raw.actions)
      ? raw.actions
      : raw && raw.action != null
        ? [raw]
        : [];
  const out = [];
  for (const item of list) {
    const action = anthropicOne(item, opts);
    if (action) out.push(action);
  }
  if (!out.length) return normalizeSiraActions(raw, opts);
  return out;
}

module.exports = { anthropicToSira };
