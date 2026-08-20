'use strict';

const path = require('path');

const MAX_TYPE_CHARS = 4000;
const MAX_KEY_CHARS = 80;
const ACTION_TYPES = new Set([
  'click', 'double_click', 'right_click', 'move', 'drag', 'scroll', 'type', 'key',
]);

function loadZod() {
  try { return require('zod'); } catch (_) { /* fall through */ }
  const candidates = [
    path.join(__dirname, '../../../backend/node_modules/zod'),
    path.join(__dirname, '../../../node_modules/zod'),
    path.join(__dirname, '../node_modules/zod'),
  ];
  for (const c of candidates) {
    try { return require(c); } catch (_) { /* next */ }
  }
  return null;
}

const zod = loadZod();
const z = zod ? zod.z || zod : null;

function coordError(name) {
  const err = new Error(`${name} must be an integer 0-10000`);
  err.name = 'ZodError';
  err.flatten = () => ({ fieldErrors: { [name]: [err.message] } });
  return err;
}

function asCoord(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 10000) throw coordError(name);
  return n;
}

function parseActionManual(body) {
  if (!body || typeof body !== 'object') {
    const err = new Error('action body required');
    err.name = 'ZodError';
    err.flatten = () => ({ fieldErrors: { type: ['required'] } });
    throw err;
  }
  const type = body.type;
  if (!ACTION_TYPES.has(type)) {
    const err = new Error(`unsupported action: ${type}`);
    err.name = 'ZodError';
    err.flatten = () => ({ fieldErrors: { type: [err.message] } });
    throw err;
  }
  const out = { type };
  if (['click', 'double_click', 'right_click', 'move', 'drag'].includes(type)) {
    out.x = asCoord(body.x, 'x');
    out.y = asCoord(body.y, 'y');
  }
  if (type === 'click' && body.button) {
    if (!['left', 'middle', 'right'].includes(body.button)) throw coordError('button');
    out.button = body.button;
  }
  if (type === 'drag') {
    out.x2 = asCoord(body.x2, 'x2');
    out.y2 = asCoord(body.y2, 'y2');
  }
  if (type === 'scroll') {
    if (body.x != null) out.x = asCoord(body.x, 'x');
    if (body.y != null) out.y = asCoord(body.y, 'y');
    if (body.dy != null) out.dy = Number(body.dy);
    if (body.dx != null) out.dx = Number(body.dx);
    if (body.direction) out.direction = body.direction;
    if (body.amount != null) out.amount = Number(body.amount);
  }
  if (type === 'type') {
    const text = String(body.text || '');
    if (!text || text.length > MAX_TYPE_CHARS) {
      const err = new Error('text is required');
      err.name = 'ZodError';
      err.flatten = () => ({ fieldErrors: { text: [err.message] } });
      throw err;
    }
    out.text = text;
  }
  if (type === 'key') {
    const key = String(body.key || '');
    if (!key || key.length > MAX_KEY_CHARS) {
      const err = new Error('key is required');
      err.name = 'ZodError';
      err.flatten = () => ({ fieldErrors: { key: [err.message] } });
      throw err;
    }
    out.key = key;
  }
  return out;
}

const ActionSchema = z
  ? z.discriminatedUnion('type', [
    z.object({
      type: z.literal('click'),
      x: z.coerce.number().finite().int().min(0).max(10000),
      y: z.coerce.number().finite().int().min(0).max(10000),
      button: z.enum(['left', 'middle', 'right']).optional(),
    }),
    z.object({
      type: z.literal('double_click'),
      x: z.coerce.number().finite().int().min(0).max(10000),
      y: z.coerce.number().finite().int().min(0).max(10000),
    }),
    z.object({
      type: z.literal('right_click'),
      x: z.coerce.number().finite().int().min(0).max(10000),
      y: z.coerce.number().finite().int().min(0).max(10000),
    }),
    z.object({
      type: z.literal('move'),
      x: z.coerce.number().finite().int().min(0).max(10000),
      y: z.coerce.number().finite().int().min(0).max(10000),
    }),
    z.object({
      type: z.literal('drag'),
      x: z.coerce.number().finite().int().min(0).max(10000),
      y: z.coerce.number().finite().int().min(0).max(10000),
      x2: z.coerce.number().finite().int().min(0).max(10000),
      y2: z.coerce.number().finite().int().min(0).max(10000),
    }),
    z.object({
      type: z.literal('scroll'),
      x: z.coerce.number().finite().int().min(0).max(10000).optional(),
      y: z.coerce.number().finite().int().min(0).max(10000).optional(),
      dy: z.coerce.number().finite().int().min(-50).max(50).optional(),
      dx: z.coerce.number().finite().int().min(-50).max(50).optional(),
      direction: z.enum(['up', 'down', 'left', 'right']).optional(),
      amount: z.coerce.number().finite().int().min(1).max(50).optional(),
    }),
    z.object({
      type: z.literal('type'),
      text: z.string().min(1).max(MAX_TYPE_CHARS),
    }),
    z.object({
      type: z.literal('key'),
      key: z.string().min(1).max(MAX_KEY_CHARS),
    }),
  ])
  : { parse: parseActionManual };

function parseAction(body) {
  if (z) return ActionSchema.parse(body);
  return parseActionManual(body);
}

function canonicalizeAction(action) {
  if (!action || typeof action !== 'object') return '';
  const keys = Object.keys(action).sort();
  const out = {};
  for (const k of keys) out[k] = action[k];
  return JSON.stringify(out);
}

module.exports = {
  ActionSchema,
  parseAction,
  parseActionManual,
  canonicalizeAction,
  MAX_TYPE_CHARS,
  MAX_KEY_CHARS,
};
