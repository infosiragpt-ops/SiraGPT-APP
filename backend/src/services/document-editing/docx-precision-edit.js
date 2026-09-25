'use strict';

// A literal edit is not a document conversion. Keep the original package and
// splice only text character ranges; never serialize a DOM or rebuild a run.
const PizZip = require('pizzip');
const { XMLValidator } = require('fast-xml-parser');
const { assertBoundedOfficePackage } = require('./edit-output-proof');

const W_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  'http://purl.oclc.org/ooxml/wordprocessingml/main',
]);
const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
const SCOPES = new Set(['document', 'body', 'header', 'footer', 'footnote', 'endnote']);
const MAX_LITERAL_LENGTH = 4096;
const MAX_DIFF_CELLS = 1000000;
const MAX_MATCHES = 10000;
// Independent of ZIP byte limits: millions of tiny XML tags (or deep stacks)
// otherwise amplify lexical walking and its namespace/context bookkeeping.
const MAX_XML_DEPTH = 256;
const MAX_XML_TOKENS = 500000;
const MAX_TEXT_NODES = 100000;
const BLOCKED_CONTAINERS = new Set(['ins', 'del', 'moveFrom', 'moveTo', 'sdt', 'fldSimple']);
const BARRIERS = new Set(['tab', 'ptab', 'br', 'cr', 'noBreakHyphen', 'softHyphen', 'sym', 'drawing', 'pict', 'object', 'fldChar', 'instrText', 'delText', 'footnoteReference', 'endnoteReference']);

class DocxPrecisionError extends Error {
  constructor(message, code = 'DOCX_EDIT_UNSUPPORTED', details = {}) {
    super(message);
    this.name = 'DocxPrecisionError';
    this.code = code;
    this.details = details;
  }
}
function fail(message, code, details) { throw new DocxPrecisionError(message, code, details); }
function unsupported() { fail('Ese contenido de Word no admite una edición exacta segura. Indica un texto normal fuera de campos, revisiones o controles protegidos.'); }

function validateEdit(edit) {
  if (!edit || typeof edit.needle !== 'string' || !edit.needle.length || typeof edit.replacement !== 'string')
    fail('Indica el texto exacto actual y su reemplazo.', 'DOCX_EDIT_INVALID_REQUEST');
  for (const value of [edit.needle, edit.replacement, ...(edit.context === undefined ? [] : [edit.context])]) {
    if (typeof value !== 'string' || value.length > MAX_LITERAL_LENGTH || /[\u0000-\u001f\u007f-\u009f\ufffe\uffff]/u.test(value)
      || !value.isWellFormed())
      fail('El cambio exacto debe contener texto válido de un solo párrafo, sin tabulaciones ni saltos de línea.', 'DOCX_EDIT_INVALID_REQUEST');
  }
  const scope = edit.scope || 'document';
  if (!SCOPES.has(scope) || (edit.all !== undefined && typeof edit.all !== 'boolean')
    || (edit.paragraph !== undefined && (!Number.isSafeInteger(edit.paragraph) || edit.paragraph < 1))
    || (edit.occurrence !== undefined && (!Number.isSafeInteger(edit.occurrence) || edit.occurrence < 1))
    || (edit.all && edit.occurrence !== undefined) || edit.context === ''
    || (edit.contextPosition !== undefined && (edit.contextPosition !== 'start' || edit.context === undefined)))
    fail('La ubicación solicitada para el cambio no es válida.', 'DOCX_EDIT_INVALID_REQUEST');
  if (edit.needle === edit.replacement) fail('El texto actual y el nuevo son iguales; no hay un cambio que aplicar.', 'DOCX_EDIT_NO_CHANGE');
  return { ...edit, scope };
}

function xmlText(raw) {
  return raw.replace(/&(?:#x([\da-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi, (_entity, hex, decimal, name) => {
    if (hex || decimal) {
      const point = parseInt(hex || decimal, hex ? 16 : 10);
      if (!(point === 9 || point === 10 || point === 13 || (point >= 32 && point <= 0xd7ff)
        || (point >= 0xe000 && point <= 0xfffd) || (point >= 0x10000 && point <= 0x10ffff)))
        fail('Entidad XML no válida.', 'DOCX_EDIT_INVALID_DOCUMENT');
      return String.fromCodePoint(point);
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[name];
  });
}
function escapeText(text) { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function attributes(tag) {
  const attrs = [];
  const re = /\s+([^\s=/>]+)\s*=\s*("[^"]*"|'[^']*')/g;
  let match;
  while ((match = re.exec(tag))) attrs.push({ name: match[1], value: xmlText(match[2].slice(1, -1)), start: match.index, end: re.lastIndex });
  return attrs;
}
function scopeForPart(name) {
  if (name === 'word/document.xml') return 'body';
  if (/^word\/header\d*\.xml$/.test(name)) return 'header';
  if (/^word\/footer\d*\.xml$/.test(name)) return 'footer';
  if (name === 'word/footnotes.xml') return 'footnote';
  if (name === 'word/endnotes.xml') return 'endnote';
  return null;
}
function storyParts(zip, scope) {
  const rank = { body: 0, header: 1, footer: 2, footnote: 3, endnote: 4 };
  return Object.keys(zip.files).filter((name) => !zip.files[name].dir && scopeForPart(name)
    && (scope === 'document' || scopeForPart(name) === scope))
    .sort((a, b) => rank[scopeForPart(a)] - rank[scopeForPart(b)] || a.localeCompare(b, 'en', { numeric: true }));
}
function readXml(zip, name) {
  const bytes = zip.file(name).asNodeBuffer();
  const xml = bytes.toString('utf8');
  if (!Buffer.from(xml).equals(bytes) || /<!DOCTYPE|<!ENTITY/i.test(xml)
    || /<\?xml\b[^?]*encoding\s*=\s*["'](?!UTF-8["']|utf-8["'])/i.test(xml)
    || XMLValidator.validate(xml) !== true)
    fail('El archivo Word contiene XML no compatible o inválido.', 'DOCX_EDIT_INVALID_DOCUMENT');
  return xml;
}

// XMLValidator checks well-formedness; this lexical walk retains source offsets
// and namespace bindings, which a DOM reserializer would destroy. Text remains
// split by actual Word paragraphs, tabs, fields and drawing boundaries.
function scanStory(xml, partName) {
  const paragraphs = [];
  const texts = [];
  const stack = [];
  let fieldDepth = 0;
  let tokenCount = 0;
  const tokens = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[^<>"']*(?:(?:"[^"]*"|'[^']*')[^<>"']*)*>/g;
  const paragraph = () => [...stack].reverse().find((item) => item.paragraph)?.paragraph;
  const barrier = () => { const p = paragraph(); if (p) p.segment += 1; };
  let match;
  while ((match = tokens.exec(xml))) {
    if (++tokenCount > MAX_XML_TOKENS)
      fail('El Word contiene demasiados elementos para una edición exacta segura. Divide el documento en archivos más pequeños.', 'DOCX_EDIT_LIMIT_EXCEEDED');
    const tag = match[0];
    if (tag.startsWith('<?') || tag.startsWith('<!--')) continue;
    if (tag.startsWith('<!')) { barrier(); continue; }
    if (tag.startsWith('</')) {
      const item = stack.pop();
      if (item?.text) {
        const raw = xml.slice(item.text.payloadStart, match.index);
        if (raw.includes('<')) unsupported();
        item.text.payloadEnd = match.index;
        item.text.raw = raw;
        item.text.text = xmlText(raw);
        texts.push(item.text);
        item.text.paragraph.nodes.push(item.text);
      }
      if (item?.paragraph) barrier();
      if (item?.blocked || item?.boundary) barrier();
      continue;
    }
    if (stack.length >= MAX_XML_DEPTH)
      fail('El Word contiene una estructura demasiado profunda para una edición exacta segura.', 'DOCX_EDIT_LIMIT_EXCEEDED');
    const qname = /^<([^\s/>]+)/.exec(tag)?.[1];
    if (!qname) fail('XML de Word no válido.', 'DOCX_EDIT_INVALID_DOCUMENT');
    const attrs = attributes(tag);
    const namespaces = { ...(stack[stack.length - 1]?.namespaces || { xml: XML_NAMESPACE }) };
    for (const attr of attrs) {
      if (attr.name === 'xmlns') namespaces[''] = attr.value;
      else if (attr.name.startsWith('xmlns:')) namespaces[attr.name.slice(6)] = attr.value;
    }
    const [prefix, local] = qname.includes(':') ? qname.split(':') : ['', qname];
    const word = W_NAMESPACES.has(namespaces[prefix]);
    const wordAttr = (name) => attrs.find((attr) => {
      const [p, l] = attr.name.includes(':') ? attr.name.split(':') : ['', attr.name];
      return l === name && W_NAMESPACES.has(namespaces[p]);
    })?.value;
    const selfClosing = /\/\s*>$/.test(tag);
    const blocked = (word && BLOCKED_CONTAINERS.has(local)) || local === 'AlternateContent';
    const boundary = word && BARRIERS.has(local);
    if (blocked || boundary) barrier();
    if (word && local === 'fldChar') {
      if (wordAttr('fldCharType') === 'begin') fieldDepth += 1;
      else if (wordAttr('fldCharType') === 'end') fieldDepth = Math.max(0, fieldDepth - 1);
    }
    const item = { qname, local, word, namespaces, blocked, boundary };
    if (word && local === 'p') {
      barrier();
      item.paragraph = { nodes: [], segment: 0, partName, index: paragraphs.length + 1 };
      paragraphs.push(item.paragraph);
    }
    if (word && local === 'r') item.run = { hidden: false };
    if (word && (local === 'vanish' || local === 'webHidden')) {
      const run = [...stack].reverse().find((entry) => entry.run)?.run;
      if (run && !['0', 'false', 'off'].includes(wordAttr('val'))) run.hidden = true;
    }
    if (word && local === 't' && !selfClosing) {
      if (texts.length >= MAX_TEXT_NODES)
        fail('El Word contiene demasiados fragmentos de texto para una edición exacta segura.', 'DOCX_EDIT_LIMIT_EXCEEDED');
      const p = paragraph();
      if (!p) unsupported();
      item.text = {
        index: texts.length, paragraph: p, segment: p.segment,
        start: match.index, tagEnd: tokens.lastIndex, openTag: tag,
        payloadStart: tokens.lastIndex,
        blocked: fieldDepth > 0 || stack.some((entry) => entry.blocked || entry.run?.hidden),
      };
    }
    if (word && local === 'documentProtection' && ['1', 'true', 'on'].includes(wordAttr('enforcement')))
      fail('El Word está protegido contra edición. Entrega una copia sin protección para aplicar el cambio exacto.');
    if (word && local === 'trackRevisions' && !['0', 'false', 'off'].includes(wordAttr('val')))
      fail('El Word tiene el control de cambios activado. Entrega una copia limpia para aplicar una edición exacta sin alterar las revisiones.');
    if (!selfClosing) stack.push(item);
  }
  if (fieldDepth) fail('El Word contiene un campo incompleto; no se modificó el archivo.', 'DOCX_EDIT_INVALID_DOCUMENT');
  for (const p of paragraphs) {
    let offset = 0;
    let lastSegment = null;
    p.text = p.nodes.map((node) => {
      const separator = lastSegment !== null && lastSegment !== node.segment ? '\uFFFC' : '';
      lastSegment = node.segment;
      offset += separator.length;
      node.charStart = offset; offset += node.text.length; node.charEnd = offset;
      return separator + node.text;
    }).join('');
  }
  return { xml, paragraphs, texts };
}

function loadPackage(buffer) {
  let zip;
  try { zip = assertBoundedOfficePackage(buffer); }
  catch (error) {
    fail('No se puede abrir este Word con seguridad.', error.code === 'OFFICE_PACKAGE_LIMIT_EXCEEDED'
      ? 'DOCX_EDIT_LIMIT_EXCEEDED' : 'DOCX_EDIT_INVALID_DOCUMENT');
  }
  if (!zip.file('word/document.xml')) fail('El archivo no es un documento DOCX.', 'DOCX_EDIT_INVALID_DOCUMENT');
  if (Object.keys(zip.files).some((name) => /^_xmlsignatures\//i.test(name) || /vbaProject\.bin$/i.test(name)))
    fail('El Word contiene firmas digitales o macros; no se modificó para evitar invalidarlas.');
  if (zip.file('word/settings.xml')) scanStory(readXml(zip, 'word/settings.xml'), 'word/settings.xml');
  return zip;
}

function planEdit(zip, edit) {
  const stories = new Map();
  const matches = [];
  let paragraphIndex = 0;
  for (const partName of storyParts(zip, edit.scope)) {
    const story = scanStory(readXml(zip, partName), partName);
    stories.set(partName, story);
    for (const paragraph of story.paragraphs) {
      paragraph.scopeIndex = ++paragraphIndex;
      if ((edit.paragraph !== undefined && edit.paragraph !== paragraphIndex)
        || (edit.context !== undefined && !(edit.contextPosition === 'start'
          ? paragraph.text.startsWith(edit.context) : paragraph.text.includes(edit.context)))) continue;
      let start = 0;
      while ((start = paragraph.text.indexOf(edit.needle, start)) !== -1) {
        const end = start + edit.needle.length;
        const nodes = paragraph.nodes.filter((node) => node.charEnd > start && node.charStart < end);
        // A literal spanning an invisible Word control is not contiguous text.
        if (nodes.length && nodes.every((node) => node.segment === nodes[0].segment)) {
          matches.push({ partName, paragraph, start, end, blocked: nodes.some((node) => node.blocked) });
          if (matches.length > MAX_MATCHES) fail('Hay demasiadas coincidencias. Indica un párrafo o una frase de contexto.', 'DOCX_EDIT_AMBIGUOUS');
        }
        // Overlapping literals are ambiguous too: both "ana" spans in
        // "banana" are possible user targets, not just the first one.
        start += 1;
      }
    }
  }
  if (!matches.length || (edit.occurrence !== undefined && edit.occurrence > matches.length))
    fail('No encontré ese texto exacto en la ubicación indicada. Revisa mayúsculas, tildes y espacios.', 'DOCX_EDIT_NOT_FOUND');
  if (matches.length > 1 && !edit.all && edit.occurrence === undefined)
    fail(`Encontré ${matches.length} coincidencias. Indica el párrafo, una frase de contexto o cuál aparición deseas cambiar.`, 'DOCX_EDIT_AMBIGUOUS', { matchCount: matches.length });
  const selected = edit.all ? matches : [matches[(edit.occurrence || 1) - 1]];
  if (selected.some((match, index) => index > 0 && selected[index - 1].paragraph === match.paragraph
    && selected[index - 1].end > match.start))
    fail('Las coincidencias se superponen. Indica cuál aparición deseas cambiar.', 'DOCX_EDIT_AMBIGUOUS');
  if (selected.some((match) => match.blocked)) unsupported();
  return { stories, selected, matchCount: matches.length };
}

// Min-cost character alignment retains unchanged letters in their ORIGINAL
// text nodes. Prefix/suffix trimming makes single-letter edits constant space.
// Ties prefer substitution, so a replacement adopts the changed letter's run.
function characterChanges(before, after) {
  const a = Array.from(before); const b = Array.from(after);
  let prefix = 0; let suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - suffix - 1] === b[b.length - suffix - 1]) suffix += 1;
  const left = a.slice(prefix, a.length - suffix); const right = b.slice(prefix, b.length - suffix);
  if ((left.length + 1) * (right.length + 1) > MAX_DIFF_CELLS)
    fail('El cambio abarca demasiado texto para conservar cada formato con precisión. Divide la edición en cambios más pequeños.');
  const width = right.length + 1;
  const costs = new Uint16Array((left.length + 1) * width);
  for (let x = left.length; x >= 0; x -= 1) for (let y = right.length; y >= 0; y -= 1) {
    if (x === left.length) costs[x * width + y] = right.length - y;
    else if (y === right.length) costs[x * width + y] = left.length - x;
    else costs[x * width + y] = Math.min(
      costs[(x + 1) * width + y + 1] + (left[x] === right[y] ? 0 : 1),
      costs[(x + 1) * width + y] + 1, costs[x * width + y + 1] + 1,
    );
  }
  const changes = [];
  let x = 0; let y = 0; let offset = a.slice(0, prefix).join('').length;
  while (x < left.length || y < right.length) {
    const cost = costs[x * width + y];
    if (x < left.length && y < right.length && left[x] === right[y] && cost === costs[(x + 1) * width + y + 1]) {
      offset += left[x++].length; y += 1;
    } else if (x < left.length && y < right.length && cost === costs[(x + 1) * width + y + 1] + 1) {
      changes.push({ start: offset, end: offset + left[x].length, text: right[y++] }); offset += left[x++].length;
    } else if (x < left.length && cost === costs[(x + 1) * width + y] + 1) {
      changes.push({ start: offset, end: offset + left[x].length, text: '' }); offset += left[x++].length;
    } else { changes.push({ start: offset, end: offset, text: right[y++] }); }
  }
  return changes;
}

// Decoded UTF-16 boundaries -> literal XML boundaries. Untouched entities keep
// their spelling (&#65; is not silently normalized to A or &amp;).
function rawBoundaries(raw) {
  const map = [0]; let cursor = 0;
  for (const token of raw.matchAll(/&(?:#[xX][\da-fA-F]+|#\d+|amp|lt|gt|quot|apos);|[^&]/gu)) {
    if (token.index !== cursor) fail('Entidad XML no compatible.', 'DOCX_EDIT_INVALID_DOCUMENT');
    const value = xmlText(token[0]);
    for (let n = 1; n <= value.length; n += 1) map.push(n === value.length ? token.index + token[0].length : null);
    cursor = token.index + token[0].length;
  }
  if (cursor !== raw.length) fail('Entidad XML no compatible.', 'DOCX_EDIT_INVALID_DOCUMENT');
  return map;
}

function buildNodeEdits(plan, edit) {
  const edits = new Map();
  const changes = characterChanges(edit.needle, edit.replacement);
  for (const match of plan.selected) for (const change of changes) {
    const start = match.start + change.start; const end = match.start + change.end;
    const nodes = match.paragraph.nodes;
    const node = start === end
      ? (nodes.find((item) => item.charStart <= start && start < item.charEnd)
        || [...nodes].reverse().find((item) => item.charStart < start && start <= item.charEnd))
      : nodes.find((item) => item.charStart <= start && start < item.charEnd);
    if (!node || end > node.charEnd || node.blocked) unsupported();
    if (!edits.has(node)) edits.set(node, []);
    edits.get(node).push({ start: start - node.charStart, end: end - node.charStart, text: change.text });
  }
  return edits;
}
function applyPatches(source, patches) {
  let output = source;
  // Stable sorting keeps multiple insertions at a common boundary in order.
  for (const patch of [...patches].reverse().sort((a, b) => b.start - a.start || b.end - a.end))
    output = output.slice(0, patch.start) + patch.text + output.slice(patch.end);
  return output;
}
function preserveSpaceTag(tag, text, before = '') {
  // Do not "repair" spacing that already existed in an unrelated part of the
  // run: that too would be an unrequested formatting change.
  const spaces = (value) => [value.match(/^ +/)?.[0] || '', value.match(/ +$/)?.[0] || '', ...value.matchAll(/ {2,}/g)].map(String).join('|');
  if (!/^ | $| {2}/.test(text) || spaces(text) === spaces(before)) return tag;
  const space = attributes(tag).find((attr) => attr.name === 'xml:space');
  if (space?.value === 'preserve') return tag;
  if (space) return tag.slice(0, space.start) + ' xml:space="preserve"' + tag.slice(space.end);
  return tag.slice(0, -1) + ' xml:space="preserve">';
}
function mutableTextMask(story, mutableIndices) {
  const patches = [];
  for (const node of story.texts) if (mutableIndices.has(node.index)) {
    patches.push({ start: node.payloadStart, end: node.payloadEnd, text: '' });
    const attr = attributes(node.openTag).find((item) => item.name === 'xml:space');
    if (attr) patches.push({ start: node.start + attr.start, end: node.start + attr.end, text: '' });
  }
  return applyPatches(story.xml, patches);
}

// The verifier re-opens the delivered ZIP, recomputes literal target selection,
// checks expected paragraph text, and masks only the allowed text nodes. It does
// not accept a repacked archive or an execution log as proof of preservation.
function verifyDocxPrecisionEdit(beforeBuffer, afterBuffer, rawEdit) {
  try {
    const edit = validateEdit(rawEdit);
    const before = loadPackage(beforeBuffer); const after = loadPackage(afterBuffer);
    const plan = planEdit(before, edit);
    const nodeEdits = buildNodeEdits(plan, edit);
    const names = Object.keys(before.files).sort();
    if (JSON.stringify(names) !== JSON.stringify(Object.keys(after.files).sort())) throw new Error('package_entries_changed');
    const changedParts = [...new Set(plan.selected.map((match) => match.partName))];
    for (const name of names) {
      if (before.files[name].dir !== after.files[name].dir) throw new Error('package_entry_type_changed');
      if (!before.files[name].dir && !changedParts.includes(name)
        && !before.file(name).asNodeBuffer().equals(after.file(name).asNodeBuffer())) throw new Error('unrequested_package_changes');
    }
    for (const partName of changedParts) {
      const source = plan.stories.get(partName);
      const result = scanStory(readXml(after, partName), partName);
      if (source.paragraphs.length !== result.paragraphs.length || source.texts.length !== result.texts.length) throw new Error('text_structure_changed');
      const mutable = new Set([...nodeEdits.keys()].filter((node) => node.paragraph.partName === partName).map((node) => node.index));
      if (mutableTextMask(source, mutable) !== mutableTextMask(result, mutable)) throw new Error('unrequested_xml_changes');
      for (const node of source.texts) {
        const expected = applyPatches(node.text, nodeEdits.get(node) || []);
        const actual = result.texts[node.index];
        if (expected !== actual.text || actual.openTag !== (nodeEdits.has(node)
          ? preserveSpaceTag(node.openTag, expected, node.text) : node.openTag)) throw new Error('text_or_format_mismatch');
      }
      for (let n = 0; n < source.paragraphs.length; n += 1) {
        const paragraph = source.paragraphs[n];
        const patches = plan.selected.filter((match) => match.paragraph === paragraph)
          .map((match) => ({ start: match.start, end: match.end, text: edit.replacement }));
        if (applyPatches(paragraph.text, patches) !== result.paragraphs[n].text) throw new Error('requested_text_not_applied');
      }
    }
    return {
      passed: true, scope: 'requested_text_and_unchanged_other_parts',
      changedParts, unchangedPartCount: names.filter((name) => !before.files[name].dir && !changedParts.includes(name)).length,
      changedTextNodes: nodeEdits.size, changedCount: plan.selected.length,
      formattingPreserved: true,
    };
  } catch (error) { return { passed: false, reason: error.code || error.message || 'precision_verification_failed' }; }
}

function applyDocxPrecisionEdit(buffer, rawEdit) {
  const edit = validateEdit(rawEdit);
  const zip = loadPackage(buffer);
  const plan = planEdit(zip, edit);
  const nodeEdits = buildNodeEdits(plan, edit);
  const partPatches = new Map();
  for (const [node, changes] of nodeEdits) {
    const map = rawBoundaries(node.raw);
    const payloadPatches = changes.map((change) => {
      if (map[change.start] == null || map[change.end] == null) unsupported();
      return { start: map[change.start], end: map[change.end], text: escapeText(change.text) };
    });
    const payload = applyPatches(node.raw, payloadPatches);
    const openTag = preserveSpaceTag(node.openTag, xmlText(payload), node.text);
    const partName = node.paragraph.partName;
    if (!partPatches.has(partName)) partPatches.set(partName, []);
    partPatches.get(partName).push({ start: node.start, end: node.payloadEnd, text: openTag + payload });
  }
  // The bounded copy validates input; the ORIGINAL reader retains dates,
  // comments, permissions and compressed payloads of unedited entries.
  const outputZip = new PizZip(buffer);
  for (const [partName, patches] of partPatches) {
    const original = outputZip.file(partName);
    outputZip.file(partName, applyPatches(plan.stories.get(partName).xml, patches), {
      date: original.date, comment: original.comment, unixPermissions: original.unixPermissions,
      dosPermissions: original.dosPermissions, createFolders: false,
    });
  }
  const output = outputZip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
  const validation = verifyDocxPrecisionEdit(buffer, output, edit);
  if (!validation.passed) fail('No se pudo verificar la conservación exacta del Word. No se entregó ningún archivo modificado.', 'DOCX_EDIT_VERIFICATION_FAILED');
  return {
    buffer: output, changedCount: plan.selected.length, matchCount: plan.matchCount,
    validation,
    locations: plan.selected.map((match) => ({ partName: match.partName, scope: scopeForPart(match.partName), paragraph: match.paragraph.scopeIndex })),
  };
}

module.exports = {
  applyDocxPrecisionEdit, verifyDocxPrecisionEdit, DocxPrecisionError,
  // Shared lexical text primitives: both editors preserve unchanged characters
  // in their original runs instead of flattening rich text into the first run.
  INTERNAL: { characterChanges, rawBoundaries, applyPatches, preserveSpaceTag, xmlText, escapeText },
};
