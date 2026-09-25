'use strict';

/**
 * Editing session over one .docx: resolves ids across parts, runs operations,
 * keeps the change log and produces the edited package.
 */

const X = require('./xml-scan');
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
  const partNames = [...pkg.parts.keys()].sort((a, b) => PART_ORDER(a) - PART_ORDER(b) || a.localeCompare(b));

  const model = (partName) => {
    if (!models.has(partName)) models.set(partName, M.buildPartModel(pkg.part(partName)));
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
    const part = pkg.part(partName);
    const next = X.applySplices(part.xml, splices);
    // Re-scan immediately: an op must never leave a part that does not parse.
    X.scan(next);
    part.xml = next;
    models.delete(partName);
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
      let re = null;
      if (regex) {
        try { re = new RegExp(String(query), 'giu'); } catch (err) { throw new DocxOpError(`Expresión regular inválida: ${err.message}`, 'DOCX_ENGINE_BAD_ARGS'); }
      }
      for (const { para } of scopeParagraphs(null)) {
        const hits = re ? [...para.text.matchAll(re)].map((m) => ({ start: m.index, end: m.index + m[0].length })) : findAll(para.text, String(query));
        for (const h of hits) {
          const from = Math.max(0, h.start - 40);
          results.push(`${para.cell || para.id}${para.cell ? ` (${para.id})` : ''}: …${M.clip(para.text.slice(from, h.end + 40), 120)}…`);
          if (results.length >= maxResults) return results;
        }
      }
      return results;
    },

    apply(opName, args = {}) {
      const op = OPS[opName];
      if (!op) throw new DocxOpError(`Operación desconocida "${opName}".`, 'DOCX_ENGINE_BAD_ARGS');
      const recorded = op(session, args || {});
      changes.push(...recorded);
      return recorded;
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
