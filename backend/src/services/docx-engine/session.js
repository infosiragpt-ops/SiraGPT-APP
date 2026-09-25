'use strict';

/**
 * Editing session over one .docx: resolves ids across parts, runs operations,
 * keeps the change log and produces the edited package.
 */

const X = require('./xml-scan');
const { XMLValidator } = require('fast-xml-parser');
const M = require('./model');
const { openDocxPackage, saveDocxPackage } = require('./package');
const { OPS, DocxOpError, findAll, looseKey } = require('./ops');

const PART_ORDER = (name) => {
  if (/header/.test(name)) return 0;
  if (name === 'word/document.xml') return 1;
  if (/footer/.test(name)) return 2;
  return 3;
};

function createDocxSession(buffer, { filename = 'documento.docx' } = {}) {
  const pkg = openDocxPackage(buffer);
  const models = new Map();
  const changes = [];
  const identities = new Map();
  const counters = new Map();
  let operationCount = 0;
  for (const name of pkg.parts.keys()) identities.set(name, new Map());
  const partNames = [...pkg.parts.keys()].sort((a, b) => PART_ORDER(a) - PART_ORDER(b) || a.localeCompare(b));

  const model = (partName) => {
    if (!models.has(partName)) {
      const registry = identities.get(partName);
      const identify = (base, node, _index, suffix = '') => {
        const key = `${base}:${node.start}${suffix}`;
        if (registry.has(key)) return registry.get(key).id;
        if (registry.size >= 30_000) throw new DocxOpError('El documento contiene demasiados elementos editables.', 'DOCX_ENGINE_TOO_LARGE');
        const countKey = `${partName}:${base}`;
        const next = counters.get(countKey) || 0;
        counters.set(countKey, next + 1);
        const id = `${base}${next}`;
        registry.set(key, { id, base, suffix, start: node.start, end: node.end, name: node.name });
        return id;
      };
      models.set(partName, M.buildPartModel(pkg.part(partName), identify));
    }
    return models.get(partName);
  };

  const partForId = (id) => {
    const m = /^([a-z]+\d*)\.(?=[a-z])/i.exec(String(id || ''));
    if (m && !/^(?:p|t|sdt|cb)\d/.test(id)) {
      const part = pkg.partByLabel(m[1]);
      return part ? part.name : null;
    }
    return 'word/document.xml';
  };

  const resolve = (id) => {
    if (typeof id !== 'string' || !id.trim()) return null;
    const clean = id.trim();
    const partName = partForId(clean);
    if (!partName || !pkg.part(partName)) return null;
    const m = model(partName);
    const entry = m.byId.get(clean);
    return entry ? { partName, model: m, entry } : null;
  };

  const commit = (partName, splices) => {
    if (!splices.length) return;
    if (splices.length > 50_000) throw new DocxOpError('Demasiados cambios en una operación.', 'DOCX_ENGINE_TOO_LARGE');
    const part = pkg.part(partName);
    model(partName); // Register all currently addressable original elements.
    const next = X.applySplices(part.xml, splices);
    if (Buffer.byteLength(next) > 25 * 1024 * 1024 || XMLValidator.validate(next) !== true)
      throw new DocxOpError('La edición no produce XML válido dentro de los límites.', 'DOCX_ENGINE_INVALID_XML');
    X.scan(next);
    // IDs survive offset shifts; deleted IDs are never reassigned to a different
    // element. This keeps a batch targeting original p1/p2 safe after deleting p0.
    const updated = new Map();
    for (const record of identities.get(partName).values()) {
      const covering = splices.find((p) => p.end > p.start && p.start <= record.start && record.start < p.end);
      let moved;
      if (covering) {
        const sameElement = covering.start === record.start && covering.end === record.end
          && new RegExp(`^<${record.name}(?:\\s|/?>)`).test(covering.text)
          && !/cb$/.test(record.base);
        if (!sameElement) continue;
        const shift = splices.filter((p) => p !== covering && p.end <= record.start).reduce((n, p) => n + p.text.length - (p.end - p.start), 0);
        moved = { ...record, start: record.start + shift, end: record.start + shift + covering.text.length };
      } else {
        const shiftStart = splices.filter((p) => p.end <= record.start).reduce((n, p) => n + p.text.length - (p.end - p.start), 0);
        const shiftEnd = splices.filter((p) => p.start < record.end).reduce((n, p) => n + p.text.length - (p.end - p.start), 0);
        moved = { ...record, start: record.start + shiftStart, end: record.end + shiftEnd };
      }
      updated.set(`${moved.base}:${moved.start}${moved.suffix}`, moved);
    }
    identities.set(partName, updated);
    part.xml = next;
    models.delete(partName);
  };

  const snapshot = () => {
    for (const name of partNames) model(name);
    return ({
    parts: new Map([...pkg.parts.values()].map((p) => [p.name, p.xml])),
    identities: new Map([...identities].map(([name, entries]) => [name, new Map([...entries].map(([key, value]) => [key, { ...value }]))])),
    counters: new Map(counters), changes: [...changes],
    });
  };
  const restore = (saved) => {
    for (const [name, xml] of saved.parts) pkg.part(name).xml = xml;
    identities.clear();
    for (const [name, entries] of saved.identities) identities.set(name, new Map([...entries].map(([key, value]) => [key, { ...value }])));
    // Never recycle IDs allocated by an undone edit: stale model calls then fail
    // closed instead of editing a different newly inserted paragraph.
    for (const [key, value] of saved.counters) counters.set(key, Math.max(counters.get(key) || 0, value));
    changes.splice(0, changes.length, ...saved.changes);
    models.clear();
  };

  const paragraphsOf = (hit) => {
    const { model: m, entry } = hit;
    if (entry.type === 'paragraph') return [entry.paragraph];
    if (entry.type === 'cell') return entry.cell.paragraphs.map((pid) => m.byId.get(pid).paragraph);
    if (entry.type === 'row') return entry.row.cells.flatMap((c) => c.paragraphs.map((pid) => m.byId.get(pid).paragraph));
    if (entry.type === 'table') return entry.table.rows.flatMap((r) => r.cells.flatMap((c) => c.paragraphs.map((pid) => m.byId.get(pid).paragraph)));
    if (entry.type === 'sdt') return entry.sdt.paragraphs.map((pid) => m.byId.get(pid).paragraph);
    return [];
  };

  /** Paragraphs searched by an op: a target (paragraph/cell/row/table/part label) or every part. */
  const scopeParagraphs = (target) => {
    if (target) {
      const part = pkg.partByLabel(String(target));
      if (part) {
        const m = model(part.name);
        return m.paragraphs.map((para) => ({ model: m, para }));
      }
      const hit = resolve(String(target));
      if (!hit) throw new DocxOpError(`No existe "${target}" en el documento (usa ids de doc_outline).`, 'DOCX_ENGINE_BAD_TARGET');
      return paragraphsOf(hit).map((para) => ({ model: hit.model, para }));
    }
    const out = [];
    for (const name of partNames) {
      const m = model(name);
      for (const para of m.paragraphs) out.push({ model: m, para });
    }
    return out;
  };

  const suggest = (text) => {
    const want = looseKey(text);
    if (!want) return '';
    const words = want.split(' ').filter((w) => w.length > 2);
    let best = null;
    for (const { para } of scopeParagraphs(null)) {
      const key = looseKey(para.text);
      if (!key) continue;
      const score = words.filter((w) => key.includes(w)).length / Math.max(1, words.length);
      if (score > 0 && (!best || score > best.score)) best = { score, para };
    }
    return best && best.score >= 0.5 ? `${best.para.cell || best.para.id} = «${M.clip(best.para.text, 90)}»` : '';
  };

  const rPrFrom = (id) => {
    const hit = resolve(id);
    if (!hit) return null;
    const paras = paragraphsOf(hit);
    for (const para of paras) {
      const run = para.runs.find((r) => r.segments.some((s) => s.kind === 't' && s.text.trim()));
      if (run) {
        const rPr = X.child(run.node, 'w:rPr');
        return rPr ? X.outerXml(hit.model.xml, rPr) : '';
      }
    }
    return null;
  };

  const findContentControl = (name) => {
    const want = looseKey(name);
    for (const partName of partNames) {
      const m = model(partName);
      const sdt = m.sdts.find((s) => looseKey(s.tag || '') === want || looseKey(s.alias || '') === want);
      if (sdt) return { partName, model: m, entry: m.byId.get(sdt.id) };
    }
    return null;
  };

  const session = {
    filename,
    pkg,
    changes,
    model,
    resolve,
    commit,
    snapshot,
    restore,
    paragraphsOf,
    scopeParagraphs,
    suggest,
    rPrFrom,
    findContentControl,
    partNames,

    outline({ maxChars = 24000, offset = 0 } = {}) {
      const lines = [];
      for (const name of partNames) {
        const m = model(name);
        const partLines = M.outlineLines(m);
        if (!partLines.length) continue;
        const label = pkg.part(name).label;
        if (label !== 'document') lines.push(`── ${label.startsWith('h') ? 'ENCABEZADO' : label.startsWith('f') ? 'PIE DE PÁGINA' : 'NOTAS'} (${label}) ──`);
        else lines.push('── CUERPO ──');
        lines.push(...partLines);
      }
      const sliced = lines.slice(Math.max(0, offset));
      let out = '';
      let shown = 0;
      for (const line of sliced) {
        if (out.length + line.length + 1 > maxChars) break;
        out += `${line}\n`;
        shown += 1;
      }
      const remaining = sliced.length - shown;
      return { text: out.trimEnd(), totalLines: lines.length, shownFrom: offset, shown, remaining };
    },

    read(id, { xml = false } = {}) {
      const hit = resolve(id);
      if (!hit) throw new DocxOpError(`No existe "${id}".`, 'DOCX_ENGINE_BAD_TARGET');
      const { model: m, entry } = hit;
      const lines = [];
      const describePara = (para) => {
        lines.push(`${para.id}${para.cell ? ` (en ${para.cell})` : ''}: "${para.text}"`);
        para.runs.forEach((run, i) => {
          const text = run.segments.map((s) => (s.kind === 'object' ? '[imagen]' : s.text)).join('');
          if (!text) return;
          const fmt = M.fmtTag(run.format);
          lines.push(`   run ${i}: "${M.clip(text, 100)}"${fmt ? ` {${fmt}}` : ''}`);
        });
      };
      if (entry.type === 'table') {
        lines.push(`${entry.table.id}: ${entry.table.rows.length} filas`);
        for (const row of entry.table.rows) {
          lines.push(`  ${row.id}: ${row.cells.map((c) => `${c.id.split('.').pop()}${c.gridSpan > 1 ? `⟷${c.gridSpan}` : ''}="${M.clip(M.cellText(m, c), 80)}"`).join(' | ')}`);
        }
      } else {
        for (const para of paragraphsOf(hit)) describePara(para);
        if (entry.type === 'checkbox') lines.push(`casilla ${entry.checkbox.id}: ${entry.checkbox.checked ? 'marcada' : 'sin marcar'} (${entry.checkbox.kind})`);
      }
      if (xml) {
        const node = entry.paragraph?.node || entry.cell?.node || entry.row?.node || entry.table?.node || entry.sdt?.node;
        if (node) lines.push('XML:', M.clip(X.outerXml(m.xml, node), 6000));
      }
      return lines.join('\n');
    },

    find(query, { regex = false, maxResults = 30 } = {}) {
      const results = [];
      if (regex) throw new DocxOpError('Usa texto literal para buscar en el documento.', 'DOCX_ENGINE_BAD_ARGS');
      for (const { para } of scopeParagraphs(null)) {
        const hits = findAll(para.text, String(query));
        for (const h of hits) {
          const from = Math.max(0, h.start - 40);
          results.push(`${para.cell || para.id}${para.cell ? ` (${para.id})` : ''}: …${M.clip(para.text.slice(from, h.end + 40), 120)}…`);
          if (results.length >= maxResults) return results;
        }
      }
      return results;
    },

    apply(opName, args = {}) {
      const op = Object.prototype.hasOwnProperty.call(OPS, opName) ? OPS[opName] : null;
      if (!op) throw new DocxOpError(`Operación desconocida "${opName}".`, 'DOCX_ENGINE_BAD_ARGS');
      if (++operationCount > 500) throw new DocxOpError('La edición alcanzó el límite de operaciones.', 'DOCX_ENGINE_TOO_LARGE');
      const encoded = JSON.stringify(args);
      if (!encoded || encoded.length > 100_000 || Object.prototype.hasOwnProperty.call(args || {}, '_rpr'))
        throw new DocxOpError('Argumentos de edición inválidos o demasiado grandes.', 'DOCX_ENGINE_BAD_ARGS');
      const validate = (value, depth = 0) => {
        if (depth > 8) throw new DocxOpError('Argumentos de edición demasiado anidados.', 'DOCX_ENGINE_BAD_ARGS');
        if (typeof value === 'string' && (value.length > 12_000 || !value.isWellFormed() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ufffe\uffff]/u.test(value)))
          throw new DocxOpError('El texto de edición no es válido o es demasiado largo.', 'DOCX_ENGINE_BAD_ARGS');
        if (value && typeof value === 'object') for (const nested of Object.values(value)) validate(nested, depth + 1);
      };
      validate(args);
      const saved = snapshot();
      try {
        const recorded = op(session, args || {});
        const modified = [...pkg.parts.values()].some((p) => p.xml !== saved.parts.get(p.name));
        if (!modified) throw new DocxOpError('La operación no cambió el documento.', 'DOCX_ENGINE_NO_CHANGE');
        changes.push(...recorded);
        return recorded;
      } catch (error) {
        restore(saved);
        throw error;
      }
    },

    changedParts() {
      return pkg.changedParts();
    },

    save() {
      return saveDocxPackage(pkg);
    },
  };
  return session;
}

module.exports = { createDocxSession };
