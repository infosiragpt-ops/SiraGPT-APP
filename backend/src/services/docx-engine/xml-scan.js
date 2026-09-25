'use strict';

/**
 * Offset-preserving XML scanner for OOXML parts.
 *
 * The docx engine never serializes a DOM: every edit is a splice of the
 * original part string, so bytes outside the edited element stay identical.
 * This scanner turns a part into a light element tree where each node knows
 * where its start tag, content and end tag live in the source string.
 *
 *   node = { name, start, openEnd, closeStart, end, selfClosing, parent, children }
 *     source.slice(start, openEnd)     → the start tag  (<w:p w14:paraId="…">)
 *     source.slice(openEnd, closeStart) → inner XML
 *     source.slice(start, end)         → the whole element
 *
 * Text nodes are not materialized; callers read `innerText(source, node)`.
 */

const MAX_TOKENS = 2_000_000;
const MAX_DEPTH = 512;

class XmlScanError extends Error {
  constructor(message) {
    super(message);
    this.name = 'XmlScanError';
    this.code = 'DOCX_ENGINE_INVALID_XML';
  }
}

function scan(source) {
  const xml = String(source || '');
  const root = { name: '#root', start: 0, openEnd: 0, closeStart: xml.length, end: xml.length, selfClosing: false, parent: null, children: [] };
  const stack = [root];
  let i = 0;
  let tokens = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) break;
    if (++tokens > MAX_TOKENS) throw new XmlScanError('XML demasiado grande para editar con precisión.');
    if (xml.startsWith('<!--', lt)) {
      const endComment = xml.indexOf('-->', lt + 4);
      if (endComment === -1) throw new XmlScanError('Comentario XML sin cerrar.');
      i = endComment + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const endCdata = xml.indexOf(']]>', lt + 9);
      if (endCdata === -1) throw new XmlScanError('CDATA sin cerrar.');
      i = endCdata + 3;
      continue;
    }
    if (xml.startsWith('<?', lt)) {
      const endPi = xml.indexOf('?>', lt + 2);
      if (endPi === -1) throw new XmlScanError('Instrucción XML sin cerrar.');
      i = endPi + 2;
      continue;
    }
    if (xml.startsWith('<!', lt)) {
      const endDecl = xml.indexOf('>', lt + 2);
      if (endDecl === -1) throw new XmlScanError('Declaración XML sin cerrar.');
      i = endDecl + 1;
      continue;
    }
    const gt = findTagEnd(xml, lt + 1);
    if (gt === -1) throw new XmlScanError('Etiqueta XML sin cerrar.');
    if (xml[lt + 1] === '/') {
      const name = xml.slice(lt + 2, gt).trim();
      const top = stack[stack.length - 1];
      if (top === root || top.name !== name) throw new XmlScanError(`Etiqueta de cierre inesperada </${name}>.`);
      top.closeStart = lt;
      top.end = gt + 1;
      stack.pop();
      i = gt + 1;
      continue;
    }
    const selfClosing = xml[gt - 1] === '/';
    const nameMatch = /^[^\s/>]+/.exec(xml.slice(lt + 1, gt));
    if (!nameMatch) throw new XmlScanError('Etiqueta XML sin nombre.');
    const parent = stack[stack.length - 1];
    const node = {
      name: nameMatch[0],
      start: lt,
      openEnd: gt + 1,
      closeStart: selfClosing ? gt + 1 : -1,
      end: selfClosing ? gt + 1 : -1,
      selfClosing,
      parent,
      children: [],
    };
    parent.children.push(node);
    if (!selfClosing) {
      stack.push(node);
      if (stack.length > MAX_DEPTH) throw new XmlScanError('XML demasiado profundo.');
    }
    i = gt + 1;
  }
  if (stack.length !== 1) throw new XmlScanError(`Etiqueta <${stack[stack.length - 1].name}> sin cerrar.`);
  return root;
}

function findTagEnd(xml, from) {
  let quote = null;
  for (let j = from; j < xml.length; j += 1) {
    const ch = xml[j];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return j;
    }
  }
  return -1;
}

function decodeEntities(raw) {
  return String(raw).replace(/&(?:#x([\da-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi, (_m, hex, dec, named) => {
    if (hex || dec) {
      const cp = parseInt(hex || dec, hex ? 16 : 10);
      try { return String.fromCodePoint(cp); } catch { return ''; }
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[named.toLowerCase()];
  });
}

function escapeText(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(text) {
  return escapeText(text).replace(/"/g, '&quot;');
}

function innerXml(xml, node) {
  if (node.selfClosing) return '';
  return xml.slice(node.openEnd, node.closeStart);
}

function outerXml(xml, node) {
  return xml.slice(node.start, node.end);
}

function startTag(xml, node) {
  return xml.slice(node.start, node.openEnd);
}

function attr(xml, node, name) {
  const tag = startTag(xml, node);
  const re = new RegExp(`\\s${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*("([^"]*)"|'([^']*)')`);
  const m = re.exec(tag);
  if (!m) return null;
  return decodeEntities(m[2] !== undefined ? m[2] : m[3]);
}

function child(node, name) {
  return node.children.find((c) => c.name === name) || null;
}

function childrenNamed(node, name) {
  return node.children.filter((c) => c.name === name);
}

/** Depth-first walk; `visit` returning false stops descending into that node. */
function walk(node, visit) {
  for (const c of node.children) {
    if (visit(c) !== false) walk(c, visit);
  }
}

function descendants(node, name) {
  const out = [];
  walk(node, (c) => { if (c.name === name) out.push(c); });
  return out;
}

/**
 * Apply non-overlapping splices to a string. Splices are sorted by start
 * descending so earlier offsets stay valid.
 */
function applySplices(xml, splices) {
  const sorted = [...splices].sort((a, b) => b.start - a.start || b.end - a.end);
  for (let k = 1; k < sorted.length; k += 1) {
    if (sorted[k].end > sorted[k - 1].start) throw new Error('Ediciones superpuestas en el mismo elemento.');
  }
  let out = xml;
  for (const s of sorted) out = out.slice(0, s.start) + s.text + out.slice(s.end);
  return out;
}

module.exports = {
  scan,
  decodeEntities,
  escapeText,
  escapeAttr,
  innerXml,
  outerXml,
  startTag,
  attr,
  child,
  childrenNamed,
  walk,
  descendants,
  applySplices,
  XmlScanError,
};
