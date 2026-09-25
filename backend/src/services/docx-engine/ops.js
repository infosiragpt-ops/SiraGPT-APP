'use strict';

/**
 * Precise, formatting-preserving edit operations on OOXML parts.
 *
 * Every operation resolves its targets on a fresh model of the part, builds
 * string splices for ONLY the targeted elements and applies them to the part
 * XML. Runs, paragraphs and cells that are not targeted keep their original
 * bytes. Each call returns a human-readable change record for the audit log
 * ("Ver cambios") and throws a DocxOpError with a Spanish, model-actionable
 * message when the target cannot be edited safely.
 */

const X = require('./xml-scan');
const M = require('./model');
const R = require('./rpr');

class DocxOpError extends Error {
  constructor(message, code = 'DOCX_ENGINE_OP_FAILED') {
    super(message);
    this.name = 'DocxOpError';
    this.code = code;
  }
}

const RUN_CHILD_KEEP = new Set(['w:rPr', 'w:t', 'w:tab', 'w:br', 'w:cr', 'w:lastRenderedPageBreak', 'w:noBreakHyphen', 'w:softHyphen', 'w:sym']);
const PARA_KEEP_ON_REWRITE = new Set(['w:pPr', 'w:bookmarkStart', 'w:bookmarkEnd', 'w:commentRangeStart', 'w:commentRangeEnd', 'w:permStart', 'w:permEnd']);
const PLACEHOLDER_RE = /^[\s_.·…\-–—]*$/;
const PLACEHOLDER_INLINE_RE = /(_{2,}|\.{3,}|…+|-{3,}|\[\s*\]|\(\s*\))/;

function textToRunContent(text) {
  const out = [];
  const parts = String(text).split(/(\n|\t)/);
  for (const piece of parts) {
    if (piece === '\n') out.push('<w:br/>');
    else if (piece === '\t') out.push('<w:tab/>');
    else if (piece.length) out.push(`<w:t xml:space="preserve">${X.escapeText(piece)}</w:t>`);
  }
  if (!out.length) out.push('<w:t xml:space="preserve"></w:t>');
  return out.join('');
}

function newRun(rPrXml, text, runOpenTag = '<w:r>') {
  return `${runOpenTag}${rPrXml || ''}${textToRunContent(text)}</w:r>`;
}

function rPrOf(xml, runNode) {
  const rPr = X.child(runNode, 'w:rPr');
  return rPr ? X.outerXml(xml, rPr) : '';
}

function runOpenTag(xml, runNode) {
  const tag = X.startTag(xml, runNode);
  return tag.endsWith('/>') ? `${tag.slice(0, -2)}>` : tag;
}

function tStartTagWithPreserve(xml, tNode, text) {
  let tag = X.startTag(xml, tNode);
  if (tag.endsWith('/>')) tag = `${tag.slice(0, -2)}>`;
  if (/^\s|\s$/.test(text) && !/xml:space\s*=/.test(tag)) tag = tag.replace(/^<w:t\b/, '<w:t xml:space="preserve"');
  return tag;
}

function normalizeForSearch(text) {
  return String(text).replace(/\u00a0/g, ' ');
}

/** Locate `find` in `text`: exact first, then case-insensitive (same length). */
function findAll(text, find, { matchCase = false } = {}) {
  const hay = normalizeForSearch(text);
  const needle = normalizeForSearch(find);
  const hits = [];
  if (!needle) return hits;
  const scan = (h, n) => {
    let from = 0;
    for (;;) {
      const at = h.indexOf(n, from);
      if (at === -1) break;
      hits.push({ start: at, end: at + n.length });
      from = at + Math.max(1, n.length);
    }
  };
  scan(hay, needle);
  if (!hits.length && !matchCase) scan(hay.toLocaleLowerCase('es'), needle.toLocaleLowerCase('es'));
  return hits;
}

function looseKey(text) {
  return normalizeForSearch(text)
    .toLocaleLowerCase('es')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[\s:：.;,]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Splices that replace para.text[start,end) with `replacement`, keeping the
 * formatting of the run where the match starts. Tabs/breaks inside the match
 * are removed; objects (images) cannot be crossed.
 */
function textRangeSplices(xml, para, start, end, replacement) {
  const touched = para.map.filter(({ seg }) => seg.end > start && seg.start < end);
  const firstText = para.map.find(({ seg }) => seg.kind === 't' && seg.end >= start && seg.start <= start && (seg.end > start || seg.end === start));
  if (touched.some(({ seg }) => seg.kind === 'object')) {
    throw new DocxOpError('El texto buscado cruza una imagen u objeto; elige un fragmento que no incluya la imagen.', 'DOCX_ENGINE_CROSSES_OBJECT');
  }
  const splices = [];
  let inserted = false;
  const anchor = touched.find(({ seg }) => seg.kind === 't') || firstText;
  if (!anchor) throw new DocxOpError('No encontré texto editable en esa posición.', 'DOCX_ENGINE_NO_TEXT');
  const writeT = (seg, newText) => {
    const tag = tStartTagWithPreserve(xml, seg.node, newText);
    if (/[\n\t]/.test(newText)) {
      // Split into sibling w:t / w:br / w:tab elements inside the same run.
      const pieces = String(newText).split(/(\n|\t)/).map((p) => {
        if (p === '\n') return '<w:br/>';
        if (p === '\t') return '<w:tab/>';
        return `<w:t xml:space="preserve">${X.escapeText(p)}</w:t>`;
      }).join('');
      splices.push({ start: seg.node.start, end: seg.node.end, text: pieces });
    } else {
      splices.push({ start: seg.node.start, end: seg.node.end, text: `${tag}${X.escapeText(newText)}</w:t>` });
    }
  };
  if (!touched.length) {
    // Pure insertion at a boundary.
    const seg = anchor.seg;
    const at = Math.max(0, Math.min(seg.text.length, start - seg.start));
    writeT(seg, seg.text.slice(0, at) + replacement + seg.text.slice(at));
    return splices;
  }
  for (const { seg } of touched) {
    if (seg.kind === 't') {
      const keepBefore = seg.start < start ? seg.text.slice(0, start - seg.start) : '';
      const keepAfter = seg.end > end ? seg.text.slice(end - seg.start) : '';
      const add = !inserted ? replacement : '';
      inserted = true;
      writeT(seg, keepBefore + add + keepAfter);
    } else {
      // tab/br/sym fully or partly inside the match → removed.
      splices.push({ start: seg.node.start, end: seg.node.end, text: '' });
    }
  }
  if (!inserted) writeT(anchor.seg, anchor.seg.text + replacement);
  return splices;
}

function firstTextRun(para) {
  return para.runs.find((r) => r.segments.some((s) => s.kind === 't' && s.text.trim())) || para.runs.find((r) => r.segments.some((s) => s.kind === 't')) || null;
}

/** rPr to use for new text written into `para` when it has no text run of its own. */
function inheritedRPr(model, para, fallbackPara = null) {
  const xml = model.xml;
  const run = firstTextRun(para);
  if (run) return rPrOf(xml, run.node);
  const mark = R.cleanInheritedRPr(R.paragraphMarkRPr(xml, para.node));
  if (mark) return mark;
  if (fallbackPara) {
    const fr = firstTextRun(fallbackPara);
    if (fr) return rPrOf(xml, fr.node);
  }
  return '';
}

function columnNeighbourPara(model, cellEntry) {
  const { table, row, cell } = cellEntry;
  const order = [];
  for (let d = 1; d < table.rows.length; d += 1) {
    for (const ri of [row.index + d, row.index - d]) {
      const r = table.rows[ri];
      if (!r) continue;
      const c = r.cells[cell.col];
      if (!c) continue;
      order.push(c);
    }
  }
  // Same-row cells first (a data row's own formatting), then the column;
  // prefer non-bold sources so an empty data cell never inherits a header.
  const sameRow = row.cells.filter((c) => c !== cell);
  const candidates = [];
  for (const c of [...order, ...sameRow]) {
    for (const pid of c.paragraphs) {
      const p = model.byId.get(pid).paragraph;
      if (p.text.trim() && firstTextRun(p)) candidates.push(p);
    }
  }
  return candidates.find((p) => !firstTextRun(p).format.bold) || candidates[0] || null;
}

/**
 * Rebuild a paragraph's content: keep its pPr and bookmark-like markers, drop
 * runs/containers, and write `runsXml` after pPr.
 */
function rewriteParagraphSplice(xml, paraNode, runsXml) {
  const kept = [];
  let pPrXml = '';
  for (const c of paraNode.children) {
    if (c.name === 'w:pPr') pPrXml = X.outerXml(xml, c);
    else if (PARA_KEEP_ON_REWRITE.has(c.name)) kept.push(X.outerXml(xml, c));
  }
  const open = X.startTag(xml, paraNode).replace(/\/>$/, '>');
  const starts = kept.filter((k) => /^<w:(?:bookmarkStart|commentRangeStart|permStart)/.test(k));
  const ends = kept.filter((k) => !/^<w:(?:bookmarkStart|commentRangeStart|permStart)/.test(k));
  return { start: paraNode.start, end: paraNode.end, text: `${open}${pPrXml}${starts.join('')}${runsXml}${ends.join('')}</w:p>` };
}

function paragraphXmlClone(xml, templatePara, runsXml) {
  const pPr = X.child(templatePara.node, 'w:pPr');
  let pPrXml = pPr ? X.outerXml(xml, pPr) : '';
  // A cloned paragraph must never carry the section break of its template.
  pPrXml = pPrXml.replace(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g, '').replace(/<w:sectPr\b[^>]*\/>/g, '');
  const open = X.startTag(xml, templatePara.node).replace(/\/>$/, '>').replace(/\s(?:w14:paraId|w14:textId|w:rsidR|w:rsidRDefault|w:rsidP|w:rsidRPr)="[^"]*"/g, '');
  return `${open}${pPrXml}${runsXml}</w:p>`;
}

function describe(text, max = 80) {
  return M.clip(String(text || ''), max);
}

// ─── Operations ────────────────────────────────────────────────────────────

/**
 * replace_text: find text (cross-run aware) and replace it, keeping the
 * formatting of the run where each match starts.
 */
function opReplaceText(session, { find, replace = '', target = null, occurrence = null, all = false, match_case = false } = {}) {
  if (typeof find !== 'string' || !find.length) throw new DocxOpError('Indica en "find" el texto exacto que quieres reemplazar.', 'DOCX_ENGINE_BAD_ARGS');
  if (typeof replace !== 'string') throw new DocxOpError('"replace" debe ser texto.', 'DOCX_ENGINE_BAD_ARGS');
  const scopes = session.scopeParagraphs(target);
  const hits = [];
  for (const { model, para } of scopes) {
    for (const h of findAll(para.text, find, { matchCase: match_case })) hits.push({ model, para, ...h });
  }
  if (!hits.length) {
    const suggestion = session.suggest(find);
    throw new DocxOpError(`No encontré «${describe(find)}» en el documento${target ? ` (dentro de ${target})` : ''}.${suggestion ? ` Lo más parecido: ${suggestion}` : ' Usa doc_find para ubicar el texto exacto.'}`, 'DOCX_ENGINE_NOT_FOUND');
  }
  let chosen = hits;
  if (!all) {
    if (occurrence) {
      const n = Number(occurrence);
      if (!Number.isInteger(n) || n < 1 || n > hits.length) throw new DocxOpError(`Hay ${hits.length} coincidencia(s); "occurrence" debe estar entre 1 y ${hits.length}.`, 'DOCX_ENGINE_BAD_ARGS');
      chosen = [hits[n - 1]];
    } else if (hits.length > 1) {
      const where = hits.slice(0, 8).map((h) => h.para.cell || h.para.id).join(', ');
      throw new DocxOpError(`«${describe(find)}» aparece ${hits.length} veces (${where}). Indica "occurrence", un "target" (id de párrafo/celda) o "all": true.`, 'DOCX_ENGINE_AMBIGUOUS');
    }
  }
  // Group by part → one splice batch per part (non-overlapping by construction:
  // several hits in the same paragraph are applied from last to first).
  const byPart = new Map();
  for (const h of chosen) {
    const key = h.model.part.name;
    if (!byPart.has(key)) byPart.set(key, []);
    byPart.get(key).push(h);
  }
  const changes = [];
  for (const [partName, list] of byPart) {
    // Apply paragraph by paragraph, re-modelling between hits in the same paragraph.
    const paraIds = [...new Set(list.map((h) => h.para.id))];
    for (const pid of paraIds) {
      const inPara = list.filter((h) => h.para.id === pid).sort((a, b) => b.start - a.start);
      for (const h of inPara) {
        const model = session.model(partName);
        const para = model.byId.get(pid).paragraph;
        const before = para.text;
        const splices = textRangeSplices(model.xml, para, h.start, h.end, replace);
        session.commit(partName, splices);
        const after = session.model(partName).byId.get(pid).paragraph.text;
        changes.push({ op: 'replace_text', target: para.cell || pid, before: describe(before, 120), after: describe(after, 120) });
      }
    }
  }
  return changes;
}

function cellEntryOrThrow(session, id) {
  const hit = session.resolve(id);
  if (!hit || hit.entry.type !== 'cell') throw new DocxOpError(`"${id}" no es una celda. Usa ids como t0.r2.c1 (ver doc_outline).`, 'DOCX_ENGINE_BAD_TARGET');
  return hit;
}

/**
 * set_cell: write text into a table cell. Keeps the cell's paragraph
 * properties and the run formatting already used in that cell (or, for an
 * empty cell, its paragraph-mark formatting or the same column's formatting).
 */
function opSetCell(session, { cell, text = '', mode = 'replace', bold = undefined, align = undefined, format_from = null, _rpr = null } = {}) {
  if (typeof text !== 'string') throw new DocxOpError('"text" debe ser texto.', 'DOCX_ENGINE_BAD_ARGS');
  const hit = cellEntryOrThrow(session, cell);
  const { model, partName } = hit;
  const cellEntry = hit.entry;
  const c = cellEntry.cell;
  if (c.vMerge === 'continue') {
    throw new DocxOpError(`La celda ${cell} es la continuación de una celda combinada verticalmente; escribe en la celda superior de esa combinación.`, 'DOCX_ENGINE_MERGED_CELL');
  }
  if (c.tables.length) throw new DocxOpError(`La celda ${cell} contiene una tabla anidada; edita las celdas de esa tabla (${c.tables.join(', ')}).`, 'DOCX_ENGINE_NESTED_TABLE');
  const paras = c.paragraphs.map((pid) => model.byId.get(pid).paragraph).filter((p) => !p.textbox);
  if (!paras.length) throw new DocxOpError(`La celda ${cell} no tiene párrafos editables.`, 'DOCX_ENGINE_BAD_TARGET');
  const beforeText = M.cellText(model, c);
  if (mode === 'append') {
    const last = paras[paras.length - 1];
    let rPr = _rpr !== null ? _rpr : inheritedRPr(model, last, columnNeighbourPara(model, cellEntry));
    if (format_from) rPr = session.rPrFrom(format_from) ?? rPr;
    if (bold !== undefined) rPr = R.applyRunProps(rPr, { bold });
    const sep = last.text && !/\s$/.test(last.text) && !/^\s/.test(text) ? ' ' : '';
    const splice = { start: last.node.closeStart, end: last.node.closeStart, text: newRun(rPr, sep + text) };
    session.commit(partName, [splice]);
  } else {
    const first = paras[0];
    let rPr = _rpr !== null ? _rpr : inheritedRPr(model, first, columnNeighbourPara(model, cellEntry));
    if (format_from) rPr = session.rPrFrom(format_from) ?? rPr;
    if (bold !== undefined) rPr = R.applyRunProps(rPr, { bold });
    const lines = String(text).split(/\r?\n/);
    const splices = [];
    const firstRuns = newRun(rPr, lines[0]);
    splices.push(rewriteParagraphSplice(model.xml, first.node, firstRuns));
    const extra = lines.slice(1).map((line) => paragraphXmlClone(model.xml, first, newRun(rPr, line))).join('');
    if (extra) splices.push({ start: first.node.end, end: first.node.end, text: extra });
    // Remove the cell's other paragraphs (the cell keeps exactly the new content).
    for (const p of paras.slice(1)) splices.push({ start: p.node.start, end: p.node.end, text: '' });
    // A later paragraph removal must not overlap the insertion splice at first.node.end.
    session.commit(partName, mergeAdjacentInsert(splices));
    if (align) opSetFormat(session, { target: cell, align });
  }
  const after = M.cellText(session.model(partName), session.model(partName).byId.get(c.id).cell);
  return [{ op: 'set_cell', target: cell, before: describe(beforeText), after: describe(after) }];
}

// An insertion at X and a removal starting at X are ordered deterministically
// by applySplices (end-desc for equal start) — keep them as-is.
function mergeAdjacentInsert(splices) {
  return splices;
}

function opSetCells(session, { cells } = {}) {
  if (!Array.isArray(cells) || !cells.length) throw new DocxOpError('"cells" debe ser una lista de {cell, text}.', 'DOCX_ENGINE_BAD_ARGS');
  if (cells.length > 200) throw new DocxOpError('Máximo 200 celdas por llamada.', 'DOCX_ENGINE_BAD_ARGS');
  const changes = [];
  const errors = [];
  for (const item of cells) {
    try {
      changes.push(...opSetCell(session, item || {}));
    } catch (err) {
      errors.push(`${item && item.cell}: ${err.message}`);
    }
  }
  if (errors.length && !changes.length) throw new DocxOpError(errors.join(' | '), 'DOCX_ENGINE_OP_FAILED');
  if (errors.length) changes.push({ op: 'warning', target: 'set_cells', before: '', after: `No se aplicaron: ${errors.join(' | ')}` });
  return changes;
}

/**
 * fill_field: put a value next to a form label ("Apellidos y nombres:").
 * Strategy, in order: the empty cell to the right of a label-only cell; a
 * placeholder (____, ……, [ ]) after the label; existing text after the
 * label (replaced); otherwise append after the label in the same paragraph.
 */
function opFillField(session, { label, value, occurrence = null, target = null, bold = undefined } = {}) {
  if (typeof label !== 'string' || !label.trim()) throw new DocxOpError('Indica en "label" la etiqueta del campo tal como aparece (p. ej. "Apellidos y nombres del experto:").', 'DOCX_ENGINE_BAD_ARGS');
  if (typeof value !== 'string') throw new DocxOpError('"value" debe ser texto.', 'DOCX_ENGINE_BAD_ARGS');
  const scopes = session.scopeParagraphs(target);
  const want = looseKey(label);
  const hits = [];
  for (const { model, para } of scopes) {
    const lines = para.text.split('\n');
    let offset = 0;
    for (const line of lines) {
      const key = looseKey(line);
      const idx = key.indexOf(want);
      if (want && idx !== -1) {
        const raw = findAll(line, label.trim().replace(/[\s:：]+$/, ''));
        const local = raw.length ? raw[0] : null;
        if (local) hits.push({ model, para, lineStart: offset, lineEnd: offset + line.length, labelStart: offset + local.start, labelEnd: offset + local.end });
      }
      offset += line.length + 1;
    }
  }
  if (!hits.length) {
    const suggestion = session.suggest(label);
    throw new DocxOpError(`No encontré la etiqueta «${describe(label)}».${suggestion ? ` Lo más parecido: ${suggestion}` : ''} Usa doc_outline/doc_find, o set_cell si el valor va en una celda concreta.`, 'DOCX_ENGINE_NOT_FOUND');
  }
  let hit = hits[0];
  if (hits.length > 1) {
    if (occurrence) {
      const n = Number(occurrence);
      if (!Number.isInteger(n) || n < 1 || n > hits.length) throw new DocxOpError(`La etiqueta aparece ${hits.length} veces; "occurrence" debe estar entre 1 y ${hits.length}.`, 'DOCX_ENGINE_BAD_ARGS');
      hit = hits[n - 1];
    } else {
      const where = hits.slice(0, 6).map((h) => h.para.cell || h.para.id).join(', ');
      throw new DocxOpError(`La etiqueta «${describe(label)}» aparece ${hits.length} veces (${where}). Indica "occurrence" o "target".`, 'DOCX_ENGINE_AMBIGUOUS');
    }
  }
  const { model, para } = hit;
  const partName = model.part.name;
  // Label ends with ':'? Include it in the label span so the value goes after it.
  let labelEnd = hit.labelEnd;
  const tail = para.text.slice(labelEnd, hit.lineEnd);
  const colon = /^\s*[:：]/.exec(tail);
  if (colon) labelEnd += colon[0].length;
  const rest = para.text.slice(labelEnd, hit.lineEnd);

  // (1) Label-only cell with an empty/placeholder cell to its right.
  if (para.cell) {
    const cellHit = session.resolve(para.cell);
    const { row, cell } = cellHit.entry;
    const cellAll = M.cellText(model, cell);
    const labelOnly = looseKey(cellAll) === looseKey(para.text.slice(hit.lineStart, labelEnd)) || !rest.trim();
    const right = row.cells[cell.col + 1];
    if (labelOnly && right && right.vMerge !== 'continue' && !right.tables.length) {
      const rightText = M.cellText(model, right);
      // The right cell is the value slot unless it is itself another label ("Grado académico:").
      const rightIsLabel = /[:：]\s*$/.test(rightText.trim());
      if (!rightIsLabel) {
        const labelRun = runAt(para, hit.labelStart);
        const labelRPr = labelRun ? rPrOf(model.xml, labelRun.node) : '';
        const rightPara = right.paragraphs.length ? model.byId.get(right.paragraphs[0]).paragraph : null;
        const existing = rightPara && firstTextRun(rightPara);
        let rPr = existing ? rPrOf(model.xml, existing.node) : '';
        if (!existing) {
          const mark = rightPara ? R.cleanInheritedRPr(R.paragraphMarkRPr(model.xml, rightPara.node)) : '';
          rPr = mark ? R.applyRunProps(mark, { bold: false }) : R.plainValueRPr(labelRPr);
        }
        if (bold !== undefined) rPr = R.applyRunProps(rPr, { bold });
        const changes = opSetCell(session, { cell: right.id, text: value, _rpr: rPr });
        return changes.map((c) => ({ ...c, op: 'fill_field', label: describe(label, 60), value: describe(value, 120) }));
      }
    }
  }

  const beforeText = para.text;
  const labelRun = runAt(para, Math.max(hit.labelStart, labelEnd - 1));
  const labelRPr = labelRun ? rPrOf(model.xml, labelRun.node) : '';
  let valueRPr = R.plainValueRPr(labelRPr);
  if (bold !== undefined) valueRPr = R.applyRunProps(valueRPr, { bold });

  // (2) Placeholder or (3) existing value after the label on the same line.
  if (rest.trim()) {
    const ph = PLACEHOLDER_INLINE_RE.exec(rest);
    const start = ph ? labelEnd + ph.index : labelEnd + (rest.length - rest.trimStart().length);
    const end = ph ? start + ph[0].length : hit.lineEnd;
    const lead = /^\s/.test(para.text.slice(labelEnd, start) || '') || start > labelEnd ? '' : ' ';
    const splices = textRangeSplices(model.xml, para, start, end, lead + value);
    session.commit(partName, splices);
  } else {
    // (4) A new run with the value's own formatting right after the label.
    const needsSpace = !/\s$/.test(para.text.slice(0, labelEnd));
    session.commit(partName, insertRunAt(model.xml, para, labelEnd, newRun(valueRPr, (needsSpace ? ' ' : '') + value)));
  }
  const after = session.model(partName).byId.get(para.id).paragraph.text;
  return [{ op: 'fill_field', target: para.cell || para.id, label: describe(label, 60), value: describe(value, 120), before: describe(beforeText, 120), after: describe(after, 120) }];
}

/**
 * Splices inserting `runXml` at text offset `offset` of `para`. When the
 * offset falls inside a w:t, that run is split in two around the new run so
 * neither half changes formatting.
 */
function insertRunAt(xml, para, offset, runXml) {
  const inside = para.map.find(({ seg }) => seg.kind === 't' && seg.start < offset && seg.end > offset);
  if (!inside) {
    const before = [...para.map].reverse().find(({ seg }) => seg.end <= offset);
    if (before) return [{ start: before.run.node.end, end: before.run.node.end, text: runXml }];
    const after = para.map.find(({ seg }) => seg.start >= offset);
    if (after) return [{ start: after.run.node.start, end: after.run.node.start, text: runXml }];
    return [{ start: para.node.closeStart, end: para.node.closeStart, text: runXml }];
  }
  const { run, seg } = inside;
  const node = run.node;
  const open = runOpenTag(xml, node);
  const rPr = rPrOf(xml, node);
  const cut = offset - seg.start;
  const beforeKids = [];
  const afterKids = [];
  let passed = false;
  for (const c of node.children) {
    if (c.name === 'w:rPr') continue;
    if (c === seg.node) { passed = true; continue; }
    (passed ? afterKids : beforeKids).push(X.outerXml(xml, c));
  }
  const tBefore = `<w:t xml:space="preserve">${X.escapeText(seg.text.slice(0, cut))}</w:t>`;
  const tAfter = `<w:t xml:space="preserve">${X.escapeText(seg.text.slice(cut))}</w:t>`;
  const first = `${open}${rPr}${beforeKids.join('')}${tBefore}</w:r>`;
  const second = `${open.replace(/\s(?:w:rsidR|w:rsidRPr)="[^"]*"/g, '')}${rPr}${tAfter}${afterKids.join('')}</w:r>`;
  return [{ start: node.start, end: node.end, text: `${first}${runXml}${second}` }];
}

function runAt(para, offset) {
  const hit = para.map.find(({ seg }) => seg.kind === 't' && seg.start <= offset && seg.end > offset)
    || para.map.find(({ seg }) => seg.kind === 't' && seg.end === offset);
  return hit ? hit.run : null;
}

/** insert_paragraph: new paragraph(s) after/before a paragraph, cloning its layout. */
function opInsertParagraph(session, { after = null, before = null, text = '', style_from = null, bold = undefined } = {}) {
  const anchorId = after || before;
  if (!anchorId) throw new DocxOpError('Indica "after" o "before" con el id del párrafo de referencia.', 'DOCX_ENGINE_BAD_ARGS');
  const hit = session.resolve(anchorId);
  if (!hit || hit.entry.type !== 'paragraph') throw new DocxOpError(`"${anchorId}" no es un párrafo.`, 'DOCX_ENGINE_BAD_TARGET');
  const { model, partName } = hit;
  const anchor = hit.entry.paragraph;
  let template = anchor;
  if (style_from) {
    const s = session.resolve(style_from);
    if (!s || s.entry.type !== 'paragraph' || s.partName !== partName) throw new DocxOpError(`"style_from" debe ser un párrafo de la misma parte (${style_from}).`, 'DOCX_ENGINE_BAD_TARGET');
    template = s.entry.paragraph;
  }
  let rPr = inheritedRPr(model, template);
  if (bold !== undefined) rPr = R.applyRunProps(rPr, { bold });
  const lines = String(text).split(/\r?\n/);
  const xml = lines.map((line) => paragraphXmlClone(model.xml, template, newRun(rPr, line))).join('');
  const at = after ? anchor.node.end : anchor.node.start;
  session.commit(partName, [{ start: at, end: at, text: xml }]);
  return [{ op: 'insert_paragraph', target: `${after ? 'después de' : 'antes de'} ${anchorId}`, before: '', after: describe(text, 120) }];
}

/** insert_table_row: clone a row (layout, borders, shading) and fill its cells. */
function opInsertTableRow(session, { table, after_row = null, clone_row = null, cells = [] } = {}) {
  const hit = session.resolve(table);
  if (!hit || hit.entry.type !== 'table') throw new DocxOpError(`"${table}" no es una tabla.`, 'DOCX_ENGINE_BAD_TARGET');
  const { model, partName } = hit;
  const tbl = hit.entry.table;
  const afterIdx = after_row === null || after_row === undefined ? tbl.rows.length - 1 : Number(String(after_row).replace(/^.*r/, ''));
  const cloneIdx = clone_row === null || clone_row === undefined ? afterIdx : Number(String(clone_row).replace(/^.*r/, ''));
  const afterRow = tbl.rows[afterIdx];
  const cloneRow = tbl.rows[cloneIdx];
  if (!afterRow || !cloneRow) throw new DocxOpError(`Fila fuera de rango (la tabla ${table} tiene ${tbl.rows.length} filas, r0…r${tbl.rows.length - 1}).`, 'DOCX_ENGINE_BAD_ARGS');
  let rowXml = X.outerXml(model.xml, cloneRow.node);
  rowXml = rowXml.replace(/\s(?:w14:paraId|w14:textId|w:rsidR|w:rsidTr)="[^"]*"/g, '');
  session.commit(partName, [{ start: afterRow.node.end, end: afterRow.node.end, text: rowXml }]);
  const newRowId = `${table}.r${afterIdx + 1}`;
  const fresh = session.resolve(newRowId);
  const changes = [];
  const n = fresh.entry.row.cells.length;
  for (let ci = 0; ci < n; ci += 1) {
    const cellId = `${newRowId}.c${ci}`;
    const value = Array.isArray(cells) && ci < cells.length ? String(cells[ci] ?? '') : '';
    const cellHit = session.resolve(cellId);
    if (cellHit.entry.cell.vMerge === 'continue') continue;
    opSetCell(session, { cell: cellId, text: value });
  }
  changes.push({ op: 'insert_table_row', target: newRowId, before: '', after: describe((cells || []).join(' | '), 120) });
  return changes;
}

/** delete: remove a paragraph, a table row, a whole table or a text fragment. */
function opDelete(session, { target, text = null } = {}) {
  if (text) return opReplaceText(session, { find: text, replace: '', target: target || null }).map((c) => ({ ...c, op: 'delete_text' }));
  const hit = session.resolve(target);
  if (!hit) throw new DocxOpError(`No existe "${target}".`, 'DOCX_ENGINE_BAD_TARGET');
  const { model, partName, entry } = hit;
  if (entry.type === 'paragraph') {
    const para = entry.paragraph;
    const cellParas = para.cell ? model.byId.get(para.cell).cell.paragraphs.length : 0;
    if (para.props.sectionBreak || (para.cell && cellParas <= 1) || isLastBodyParagraph(model, para)) {
      // A cell needs one paragraph; a section-break paragraph carries layout — clear instead.
      session.commit(partName, [rewriteParagraphSplice(model.xml, para.node, '')]);
      return [{ op: 'clear_paragraph', target, before: describe(para.text), after: '' }];
    }
    session.commit(partName, [{ start: para.node.start, end: para.node.end, text: '' }]);
    return [{ op: 'delete_paragraph', target, before: describe(para.text), after: '' }];
  }
  if (entry.type === 'row') {
    if (entry.table.rows.length <= 1) throw new DocxOpError('No puedo dejar una tabla sin filas; elimina la tabla completa.', 'DOCX_ENGINE_BAD_TARGET');
    const text = entry.row.cells.map((c) => M.cellText(model, c)).join(' | ');
    session.commit(partName, [{ start: entry.row.node.start, end: entry.row.node.end, text: '' }]);
    return [{ op: 'delete_row', target, before: describe(text, 120), after: '' }];
  }
  if (entry.type === 'table') {
    const tbl = entry.table;
    const inCell = Boolean(tbl.parentCell);
    session.commit(partName, [{ start: tbl.node.start, end: tbl.node.end, text: inCell ? '<w:p/>' : '' }]);
    return [{ op: 'delete_table', target, before: `tabla ${target}`, after: '' }];
  }
  throw new DocxOpError(`No sé eliminar "${target}" (${entry.type}).`, 'DOCX_ENGINE_BAD_TARGET');
}

function isLastBodyParagraph(model, para) {
  if (model.part.label !== 'document' || para.cell) return false;
  const blocks = model.body.children.filter((c) => c.name === 'w:p' || c.name === 'w:tbl');
  return blocks.length && blocks[blocks.length - 1] === para.node;
}

/** set_format: bold/italic/size/color/highlight/font/alignment on a paragraph, cell, row or table. */
function opSetFormat(session, { target, text = null, bold, italic, underline, size_pt, color, highlight, font, align, style } = {}) {
  const hit = session.resolve(target);
  if (!hit) throw new DocxOpError(`No existe "${target}".`, 'DOCX_ENGINE_BAD_TARGET');
  const { model, partName } = hit;
  const paras = session.paragraphsOf(hit);
  const runProps = { bold, italic, underline, sizePt: size_pt, color, highlight, font };
  const hasRun = Object.values(runProps).some((v) => v !== undefined && v !== null);
  const splices = [];
  for (const para of paras) {
    if (hasRun) {
      const runs = text
        ? para.runs.filter((r) => r.segments.some((s) => s.kind === 't' && findAll(para.text.slice(s.start, s.end), text).length))
        : para.runs.filter((r) => r.segments.some((s) => s.kind === 't'));
      for (const run of runs) {
        const rPr = X.child(run.node, 'w:rPr');
        const updated = R.applyRunProps(rPr ? X.outerXml(model.xml, rPr) : '', runProps);
        if (rPr) splices.push({ start: rPr.start, end: rPr.end, text: updated });
        else splices.push({ start: run.node.openEnd, end: run.node.openEnd, text: updated });
      }
    }
    if (align || style) {
      const pPr = X.child(para.node, 'w:pPr');
      const updated = R.applyParagraphProps(pPr ? X.outerXml(model.xml, pPr) : '', { align, style });
      if (updated) {
        if (pPr) splices.push({ start: pPr.start, end: pPr.end, text: updated });
        else splices.push({ start: para.node.openEnd, end: para.node.openEnd, text: updated });
      }
    }
  }
  if (!splices.length) throw new DocxOpError(`No hay texto al que aplicar formato en ${target}.`, 'DOCX_ENGINE_NO_TEXT');
  session.commit(partName, splices);
  const what = Object.entries({ bold, italic, underline, size_pt, color, highlight, font, align, style })
    .filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}=${v}`).join(', ');
  return [{ op: 'set_format', target, before: '', after: what }];
}

/** set_checkbox: tick/untick a content-control, legacy form-field or glyph checkbox. */
function opSetCheckbox(session, { checkbox, checked = true } = {}) {
  const hit = session.resolve(checkbox);
  if (!hit || hit.entry.type !== 'checkbox') throw new DocxOpError(`"${checkbox}" no es una casilla (ids cbN en doc_outline).`, 'DOCX_ENGINE_BAD_TARGET');
  const { model, partName } = hit;
  const cb = hit.entry.checkbox;
  const xml = model.xml;
  const splices = [];
  const on = Boolean(checked);
  if (cb.kind === 'sdt') {
    const sdtPr = X.child(cb.sdt.node, 'w:sdtPr');
    const cbx = sdtPr && X.child(sdtPr, 'w14:checkbox');
    const checkedNode = cbx && X.child(cbx, 'w14:checked');
    if (checkedNode) splices.push({ start: checkedNode.start, end: checkedNode.end, text: `<w14:checked w14:val="${on ? 1 : 0}"/>` });
    else if (cbx) splices.push({ start: cbx.openEnd, end: cbx.openEnd, text: `<w14:checked w14:val="${on ? 1 : 0}"/>` });
    const stateNode = cbx && X.child(cbx, on ? 'w14:checkedState' : 'w14:uncheckedState');
    const code = stateNode ? X.attr(xml, stateNode, 'w14:val') : null;
    const glyph = code ? String.fromCodePoint(parseInt(code, 16)) : (on ? '☒' : '☐');
    const content = X.child(cb.sdt.node, 'w:sdtContent');
    const t = content && X.descendants(content, 'w:t')[0];
    if (t) splices.push({ start: t.start, end: t.end, text: `${X.startTag(xml, t).replace(/\/>$/, '>')}${X.escapeText(glyph)}</w:t>` });
  } else if (cb.kind === 'formfield') {
    const checkedNode = X.child(cb.node, 'w:checked');
    if (checkedNode) splices.push({ start: checkedNode.start, end: checkedNode.end, text: `<w:checked w:val="${on ? 1 : 0}"/>` });
    else splices.push({ start: cb.node.closeStart > 0 && !cb.node.selfClosing ? cb.node.closeStart : cb.node.end, end: cb.node.closeStart > 0 && !cb.node.selfClosing ? cb.node.closeStart : cb.node.end, text: `<w:checked w:val="${on ? 1 : 0}"/>` });
    if (cb.node.selfClosing) {
      splices.length = 0;
      splices.push({ start: cb.node.start, end: cb.node.end, text: `<w:checkBox><w:sizeAuto/><w:checked w:val="${on ? 1 : 0}"/></w:checkBox>` });
    }
  } else {
    const para = model.byId.get(cb.paragraph).paragraph;
    const glyph = on ? (cb.glyph === '□' ? '■' : '☒') : (cb.glyph === '■' ? '□' : '☐');
    splices.push(...textRangeSplices(xml, para, cb.offset, cb.offset + 1, glyph));
  }
  session.commit(partName, splices);
  return [{ op: 'set_checkbox', target: checkbox, before: cb.checked ? '☒' : '☐', after: on ? '☒' : '☐' }];
}

/** fill_content_control: write into a Word content control (by id, tag or title). */
function opFillContentControl(session, { control, text = '' } = {}) {
  let hit = session.resolve(control);
  if (!hit || hit.entry.type !== 'sdt') {
    const found = session.findContentControl(control);
    if (!found) throw new DocxOpError(`No encontré el control de contenido "${control}".`, 'DOCX_ENGINE_BAD_TARGET');
    hit = found;
  }
  const { model, partName } = hit;
  const sdt = hit.entry.sdt;
  if (sdt.checkbox) throw new DocxOpError('Ese control es una casilla; usa set_checkbox.', 'DOCX_ENGINE_BAD_TARGET');
  const xml = model.xml;
  const splices = [];
  const sdtPr = X.child(sdt.node, 'w:sdtPr');
  const showing = sdtPr && X.child(sdtPr, 'w:showingPlcHdr');
  if (showing) splices.push({ start: showing.start, end: showing.end, text: '' });
  const content = X.child(sdt.node, 'w:sdtContent');
  if (!content) throw new DocxOpError('El control no tiene contenido editable.', 'DOCX_ENGINE_BAD_TARGET');
  const sdtRPr = sdtPr && X.child(sdtPr, 'w:rPr');
  const cleanRPr = (rPrXml) => rPrXml.replace(/<w:rStyle\s+w:val="(?:PlaceholderText|Textodelmarcadordeposicin)"\s*\/>/gi, '').replace(/<w:rPr>\s*<\/w:rPr>/, '');
  if (sdt.paragraphs.length) {
    const first = model.byId.get(sdt.paragraphs[0]).paragraph;
    const rPr = cleanRPr(inheritedRPr(model, first));
    const lines = String(text).split(/\r?\n/);
    splices.push(rewriteParagraphSplice(xml, first.node, newRun(rPr, lines[0])));
    const extra = lines.slice(1).map((line) => paragraphXmlClone(xml, first, newRun(rPr, line))).join('');
    if (extra) splices.push({ start: first.node.end, end: first.node.end, text: extra });
    for (const pid of sdt.paragraphs.slice(1)) {
      const p = model.byId.get(pid).paragraph;
      splices.push({ start: p.node.start, end: p.node.end, text: '' });
    }
  } else {
    const runs = M.paragraphRuns(content);
    const rPr = cleanRPr(runs.length ? rPrOf(xml, runs[0]) : (sdtRPr ? X.outerXml(xml, sdtRPr) : ''));
    splices.push({ start: content.openEnd, end: content.closeStart, text: newRun(rPr, text) });
  }
  session.commit(partName, splices);
  return [{ op: 'fill_content_control', target: sdt.id, before: describe(sdt.text), after: describe(text) }];
}

const OPS = {
  replace_text: opReplaceText,
  set_cell: opSetCell,
  set_cells: opSetCells,
  fill_field: opFillField,
  insert_paragraph: opInsertParagraph,
  insert_table_row: opInsertTableRow,
  delete: opDelete,
  set_format: opSetFormat,
  set_checkbox: opSetCheckbox,
  fill_content_control: opFillContentControl,
};

module.exports = { OPS, DocxOpError, findAll, looseKey, textRangeSplices, newRun, textToRunContent };
