'use strict';

/**
 * Gemini computer-use → SiraAction[] (F7.3).
 *
 * Gemini reports pointer positions in a 0–1000 normalized space
 * (`click_at`, `type_text_at`, `scroll_at`, `drag_and_drop`, …).
 */

const {
  normalizeSiraAction,
  normalizeSiraActions,
  fromNormalizedThousand,
  isSiraActionType,
  DEFAULT_NATIVE,
} = require('./sira-action');

const GEMINI_MAP = Object.freeze({
  click_at: 'click',
  hover_at: 'move',
  type_text_at: 'type',
  type_text: 'type',
  key_combination: 'key',
  scroll_document: 'scroll',
  scroll_at: 'scroll',
  drag_and_drop: 'drag',
  wait_5_seconds: 'wait',
  navigate: 'navigate',
  open_web_browser: 'launch',
  search: 'type',
  go_back: 'key',
  go_forward: 'key',
});

function geminiOne(raw, opts = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const verb = String(raw.name || raw.action || raw.type || '').trim().toLowerCase();
  if (verb === 'done' || verb === 'request_handoff') {
    return normalizeSiraAction({ type: verb, ...raw }, opts);
  }
  if (isSiraActionType(verb) && !GEMINI_MAP[verb]) {
    return normalizeSiraAction(raw, opts);
  }
  const mapped = GEMINI_MAP[verb];
  if (!mapped) return null;

  const native = opts.native || DEFAULT_NATIVE;
  const hasNorm = raw.x != null || raw.y != null;
  const pt = hasNorm ? fromNormalizedThousand(raw.x, raw.y, native) : { x: 0, y: 0 };

  if (mapped === 'wait') {
    return normalizeSiraAction({ type: 'wait', ms: 5000 }, opts);
  }
  if (mapped === 'launch') {
    return normalizeSiraAction({ type: 'launch', app: raw.app || 'chromium' }, opts);
  }
  if (mapped === 'navigate') {
    return normalizeSiraAction({ type: 'navigate', url: raw.url || raw.text }, opts);
  }
  if (verb === 'go_back') {
    return normalizeSiraAction({ type: 'key', key: 'alt+Left' }, opts);
  }
  if (verb === 'go_forward') {
    return normalizeSiraAction({ type: 'key', key: 'alt+Right' }, opts);
  }
  if (mapped === 'key') {
    const keys = Array.isArray(raw.keys) ? raw.keys.join('+') : (raw.keys || raw.key || raw.text || '');
    return normalizeSiraAction({ type: 'key', key: keys }, opts);
  }
  if (mapped === 'type') {
    const text = String(raw.text || raw.query || '').slice(0, 2000);
    return normalizeSiraAction({ type: 'type', text }, opts);
  }
  if (mapped === 'drag') {
    const dest = fromNormalizedThousand(
      raw.destination_x ?? raw.destinationX ?? raw.x2,
      raw.destination_y ?? raw.destinationY ?? raw.y2,
      native,
    );
    return normalizeSiraAction({
      type: 'drag',
      from: pt,
      to: dest,
    }, { ...opts, image: null });
  }
  if (mapped === 'scroll') {
    const dir = String(raw.direction || '').toLowerCase();
    const mag = Number(raw.magnitude || raw.dy || 3) || 3;
    const dy = dir === 'up' ? -mag : mag;
    return normalizeSiraAction({
      type: 'scroll',
      x: pt.x,
      y: pt.y,
      dy,
      direction: dir,
    }, { ...opts, image: null });
  }
  return normalizeSiraAction({
    type: mapped,
    x: pt.x,
    y: pt.y,
    button: raw.button || 'left',
  }, { ...opts, image: null });
}

function geminiToSira(raw, opts = {}) {
  const list = Array.isArray(raw)
    ? raw
    : raw && Array.isArray(raw.actions)
      ? raw.actions
      : raw && (raw.name || raw.type || raw.action)
        ? [raw]
        : [];
  const out = [];
  for (const item of list) {
    const action = geminiOne(item, opts);
    if (action) out.push(action);
  }
  if (!out.length) return normalizeSiraActions(raw, opts);
  return out;
}

module.exports = { geminiToSira };
