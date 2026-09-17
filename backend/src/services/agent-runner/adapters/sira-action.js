'use strict';

/**
 * SiraAction — vendor-neutral computer-use action (F7.3).
 *
 * Anthropic / OpenAI / Gemini payloads are normalized HERE. The CU-loop
 * and `computer` tool speak only this shape. Do not couple the loop to
 * one LLM vendor. UI never prints a model id.
 *
 * Screen / page text riding next to an action is DATA, never instructions.
 */

const SIRA_ACTION_TYPES = Object.freeze([
  'screenshot',
  'click',
  'double_click',
  'move',
  'drag',
  'type',
  'key',
  'scroll',
  'launch',
  'navigate',
  'wait',
  'done',
  'request_handoff',
]);

const SIRA_BUTTONS = Object.freeze(['left', 'middle', 'right']);
const DEFAULT_NATIVE = Object.freeze({ width: 1920, height: 1080 });
const MAX_TYPE_CHARS = 2000;

function isSiraActionType(type) {
  return SIRA_ACTION_TYPES.includes(String(type || '').trim().toLowerCase());
}

function clampInt(raw, fallback, lo, hi) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

function clampPoint(x, y, bounds = DEFAULT_NATIVE) {
  const w = Math.max(1, Number(bounds.width) || DEFAULT_NATIVE.width);
  const h = Math.max(1, Number(bounds.height) || DEFAULT_NATIVE.height);
  return {
    x: clampInt(x, 0, 0, w - 1),
    y: clampInt(y, 0, 0, h - 1),
  };
}

function normalizeButton(raw) {
  const v = String(raw == null ? 'left' : raw).trim().toLowerCase();
  if (v === '1' || v === 'left') return 'left';
  if (v === '2' || v === 'middle') return 'middle';
  if (v === '3' || v === 'right') return 'right';
  return SIRA_BUTTONS.includes(v) ? v : 'left';
}

/**
 * Scale model-space coordinates back to the native framebuffer.
 * Used when the screenshot sent to the LLM was resized.
 */
function scalePoint(x, y, { image, native } = {}) {
  const imgW = Number(image && image.width);
  const imgH = Number(image && image.height);
  const natW = Number(native && native.width) || DEFAULT_NATIVE.width;
  const natH = Number(native && native.height) || DEFAULT_NATIVE.height;
  if (!Number.isFinite(imgW) || imgW <= 0 || !Number.isFinite(imgH) || imgH <= 0) {
    return clampPoint(x, y, { width: natW, height: natH });
  }
  return clampPoint(
    Number(x) * (natW / imgW),
    Number(y) * (natH / imgH),
    { width: natW, height: natH },
  );
}

/**
 * Gemini Computer Use reports clicks in a 0–1000 normalized space.
 */
function fromNormalizedThousand(x, y, native = DEFAULT_NATIVE) {
  const w = Number(native.width) || DEFAULT_NATIVE.width;
  const h = Number(native.height) || DEFAULT_NATIVE.height;
  return clampPoint(
    (Number(x) / 1000) * w,
    (Number(y) / 1000) * h,
    { width: w, height: h },
  );
}

function asArray(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw == null) return [];
  return [raw];
}

/**
 * Coerce a already-Sira-shaped object. Unknown types → null (caller skips).
 * @returns {object|null}
 */
function normalizeSiraAction(raw, opts = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const type = String(raw.type || raw.action || raw.kind || '').trim().toLowerCase();
  if (!isSiraActionType(type)) return null;

  const image = opts.image || raw.image || null;
  const native = opts.native || raw.native || DEFAULT_NATIVE;
  const out = { type };

  if (type === 'click' || type === 'double_click' || type === 'move' || type === 'scroll') {
    const src = raw.coordinate && Array.isArray(raw.coordinate)
      ? { x: raw.coordinate[0], y: raw.coordinate[1] }
      : raw;
    const pt = image
      ? scalePoint(src.x, src.y, { image, native })
      : clampPoint(src.x, src.y, native);
    out.x = pt.x;
    out.y = pt.y;
  }
  if (type === 'click' || type === 'double_click') {
    out.button = normalizeButton(raw.button);
  }
  if (type === 'drag') {
    const from = raw.from || raw.start || {};
    const to = raw.to || raw.end || {};
    const a = raw.path && raw.path[0];
    const b = raw.path && raw.path[raw.path.length - 1];
    const p1 = image
      ? scalePoint(from.x ?? raw.x1 ?? (a && a.x), from.y ?? raw.y1 ?? (a && a.y), { image, native })
      : clampPoint(from.x ?? raw.x1 ?? (a && a.x), from.y ?? raw.y1 ?? (a && a.y), native);
    const p2 = image
      ? scalePoint(to.x ?? raw.x2 ?? (b && b.x), to.y ?? raw.y2 ?? (b && b.y), { image, native })
      : clampPoint(to.x ?? raw.x2 ?? (b && b.x), to.y ?? raw.y2 ?? (b && b.y), native);
    out.from = p1;
    out.to = p2;
    out.x1 = p1.x;
    out.y1 = p1.y;
    out.x2 = p2.x;
    out.y2 = p2.y;
  }
  if (type === 'type') {
    out.text = String(raw.text || '').slice(0, MAX_TYPE_CHARS);
  }
  if (type === 'key') {
    out.key = String(raw.key || raw.keys || raw.text || '').trim().slice(0, 80);
  }
  if (type === 'scroll') {
    out.dy = clampInt(raw.dy ?? raw.scrollY ?? raw.scroll_y ?? raw.delta, 0, -100, 100);
    out.dx = clampInt(raw.dx ?? raw.scrollX ?? raw.scroll_x, 0, -100, 100);
    if (raw.direction) out.direction = String(raw.direction).toLowerCase();
  }
  if (type === 'launch') {
    out.app = String(raw.app || raw.name || '').trim().toLowerCase();
  }
  if (type === 'navigate') {
    out.url = String(raw.url || raw.text || '').trim();
  }
  if (type === 'wait') {
    out.ms = clampInt(raw.ms ?? raw.duration_ms ?? (Number(raw.duration) * 1000), 400, 0, 15_000);
  }
  if (type === 'done') {
    out.summary = String(raw.summary || raw.text || '').slice(0, 2000);
  }
  if (type === 'request_handoff') {
    out.reason = String(raw.reason || raw.text || 'human_needed').slice(0, 400);
  }
  return out;
}

function normalizeSiraActions(raw, opts = {}) {
  return asArray(raw)
    .map((item) => normalizeSiraAction(item, opts))
    .filter(Boolean);
}

module.exports = {
  SIRA_ACTION_TYPES,
  SIRA_BUTTONS,
  DEFAULT_NATIVE,
  MAX_TYPE_CHARS,
  isSiraActionType,
  clampPoint,
  scalePoint,
  fromNormalizedThousand,
  normalizeSiraAction,
  normalizeSiraActions,
  normalizeButton,
};
