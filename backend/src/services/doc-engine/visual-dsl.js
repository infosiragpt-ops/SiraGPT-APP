'use strict';

/**
 * Closed visual-patch DSL. The vision model may only emit these ops.
 * XML, code, paths and markup are rejected.
 */

const ALLOWED_OPS = new Set(['replace_text', 'set_style']);
const FORBIDDEN = /[<>]|<\?xml|w:|r:id|import |exec\(|eval\(|os\.|subprocess|__import__|javascript:|file:|\\\\|\/etc\/|\/proc\//i;
const SAFE_TEXT = /^[\w\s.,;:()%/+\-áéíóúñüÁÉÍÓÚÑÜ¿¡'"#@]+$/i;
const SAFE_STYLE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function rejectPayload(value, label) {
  const text = String(value == null ? '' : value);
  if (!text || text.length > 400) {
    throw new Error(`${label} empty or too long`);
  }
  if (FORBIDDEN.test(text)) {
    throw new Error(`${label} rejected: closed DSL forbids XML/code/paths`);
  }
  if (!SAFE_TEXT.test(text)) {
    throw new Error(`${label} has disallowed characters`);
  }
  return text;
}

function parseClosedDsl(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.replace(/^```(?:json)?\s*|```$/g, '').trim();
    if (FORBIDDEN.test(trimmed) && !/^\s*[{\[]/.test(trimmed)) {
      throw new Error('model emitted XML/code instead of closed DSL');
    }
    const start = trimmed.indexOf('{') >= 0 && (trimmed.indexOf('[') === -1 || trimmed.indexOf('{') < trimmed.indexOf('['))
      ? trimmed.indexOf('{')
      : trimmed.indexOf('[');
    const end = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.ops;
  if (!Array.isArray(list)) throw new Error('DSL must be a list of ops');
  if (list.length > 32) throw new Error('too many ops (max 32)');
  return list.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('each op must be an object');
    const op = String(item.op || '');
    if (!ALLOWED_OPS.has(op)) throw new Error(`unknown op '${op}'`);
    const extra = Object.keys(item).filter((k) => !['op', 'find', 'replace', 'styleId', 'textEquals'].includes(k));
    if (extra.length) throw new Error(`unknown keys ${extra.join(',')}`);
    if (op === 'replace_text') {
      return {
        op,
        find: rejectPayload(item.find, 'find'),
        replace: rejectPayload(item.replace, 'replace'),
      };
    }
    if (!SAFE_STYLE.test(String(item.styleId || ''))) {
      throw new Error('styleId must be a Word style id');
    }
    return {
      op,
      styleId: String(item.styleId),
      textEquals: rejectPayload(item.textEquals, 'textEquals'),
    };
  });
}

function looksLikeXmlOrCode(text) {
  const s = String(text || '');
  return /<\s*w:|<\?xml|```[a-z]*\n\s*(import |def |function |class )/i.test(s);
}

module.exports = {
  ALLOWED_OPS,
  parseClosedDsl,
  rejectPayload,
  looksLikeXmlOrCode,
};
