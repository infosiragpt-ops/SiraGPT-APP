'use strict';

/**
 * Addressable model of a Word part, rebuilt from the offset tree after each
 * edit. Everything the model (LLM) sees or targets has a stable, readable id:
 *
 *   p12            paragraph 12 of the body (document order, tables included)
 *   t1             table 1 of the body
 *   t1.r3.c2       table 1, row 3, cell 2 (w:tc order within the row)
 *   h1.p0 / f1.t0  same ids inside header1.xml / footer1.xml
 *   sdt4           content control 4 (block, run or cell level)
 *   cb2            checkbox 2 (content-control, legacy form field or glyph)
 *
 * Text is the rendered text of the runs: w:t, w:tab → "\t", w:br/w:cr → "\n",
 * deleted revisions (w:del) and field codes (w:instrText) are excluded.
 */

const X = require('./xml-scan');

const RUN_CONTAINERS = new Set([
  'w:hyperlink', 'w:smartTag', 'w:sdt', 'w:sdtContent', 'w:ins', 'w:fldSimple',
  'w:customXml', 'w:moveTo', 'w:dir', 'w:bdo',
]);
const CHECKBOX_GLYPHS = new Map([
  ['☐', false], ['□', false], ['❏', false], ['◻', false],
  ['☒', true], ['☑', true], ['■', true], ['✓', true], ['✔', true], ['⊠', true],
]);

function partPrefix(label) {
  return label === 'document' ? '' : `${label}.`;
}

function bodyOf(root) {
  const doc = root.children.find((c) => /:(?:document|hdr|ftr|footnotes|endnotes)$/.test(c.name));
  if (!doc) return root;
  if (doc.name === 'w:document') return X.child(doc, 'w:body') || doc;
  return doc;
}

function runSegments(xml, run) {
  const segments = [];
  for (const c of run.children) {
    switch (c.name) {
      case 'w:t':
        segments.push({ kind: 't', node: c, text: X.decodeEntities(X.innerXml(xml, c)) });
        break;
      case 'w:tab':
      case 'w:ptab':
        segments.push({ kind: 'tab', node: c, text: '\t' });
        break;
      case 'w:br':
      case 'w:cr':
        segments.push({ kind: 'br', node: c, text: '\n' });
        break;
      case 'w:noBreakHyphen':
        segments.push({ kind: 'sym', node: c, text: '\u2011' });
        break;
      case 'w:softHyphen':
        segments.push({ kind: 'sym', node: c, text: '\u00ad' });
        break;
      case 'w:sym': {
        const code = X.attr(xml, c, 'w:char');
        let ch = '';
        if (code) {
          try { ch = String.fromCodePoint(parseInt(code, 16) >= 0xf000 ? parseInt(code, 16) - 0xf000 : parseInt(code, 16)); } catch { ch = ''; }
        }
        segments.push({ kind: 'sym', node: c, text: ch });
        break;
      }
      case 'w:drawing':
      case 'w:pict':
      case 'w:object':
        segments.push({ kind: 'object', node: c, text: '' });
        break;
      default:
        break;
    }
  }
  return segments;
}

/** Runs of a paragraph in reading order, skipping deleted revisions and nested paragraphs. */
function paragraphRuns(para) {
  const runs = [];
  const visit = (node) => {
    for (const c of node.children) {
      if (c.name === 'w:r') runs.push(c);
      else if (RUN_CONTAINERS.has(c.name)) visit(c);
    }
  };
  visit(para);
  return runs;
}

function flagOn(xml, rPr, name) {
  if (!rPr) return false;
  const node = X.child(rPr, name);
  if (!node) return false;
  const val = X.attr(xml, node, 'w:val');
  return val === null || !/^(?:0|false|off|none)$/i.test(val);
}

function runFormat(xml, run) {
  const rPr = X.child(run, 'w:rPr');
  if (!rPr) return {};
  const fmt = {};
  if (flagOn(xml, rPr, 'w:b')) fmt.bold = true;
  if (flagOn(xml, rPr, 'w:i')) fmt.italic = true;
  const u = X.child(rPr, 'w:u');
  if (u) {
    const v = X.attr(xml, u, 'w:val');
    if (v && v !== 'none') fmt.underline = v;
  }
  const sz = X.child(rPr, 'w:sz');
  if (sz) fmt.sizePt = Number(X.attr(xml, sz, 'w:val')) / 2 || undefined;
  const fonts = X.child(rPr, 'w:rFonts');
  if (fonts) fmt.font = X.attr(xml, fonts, 'w:ascii') || X.attr(xml, fonts, 'w:hAnsi') || undefined;
  const color = X.child(rPr, 'w:color');
  if (color) {
    const v = X.attr(xml, color, 'w:val');
    if (v && v !== 'auto') fmt.color = v;
  }
  const hl = X.child(rPr, 'w:highlight');
  if (hl) fmt.highlight = X.attr(xml, hl, 'w:val');
  if (flagOn(xml, rPr, 'w:caps')) fmt.caps = true;
  return fmt;
}

function paragraphProps(xml, para) {
  const pPr = X.child(para, 'w:pPr');
  const props = {};
  if (!pPr) return props;
  const style = X.child(pPr, 'w:pStyle');
  if (style) props.style = X.attr(xml, style, 'w:val');
  const jc = X.child(pPr, 'w:jc');
  if (jc) props.align = X.attr(xml, jc, 'w:val');
  if (X.child(pPr, 'w:numPr')) props.list = true;
  if (X.child(pPr, 'w:sectPr')) props.sectionBreak = true;
  return props;
}

function nearest(node, name) {
  let cur = node.parent;
  while (cur) {
    if (cur.name === name) return cur;
    cur = cur.parent;
  }
  return null;
}

function protectedReason(xml, node, { allowFormField = false } = {}) {
  const unsafe = (n) => {
    if (/^w:(?:ins|del|moveFrom|moveTo|rPrChange|pPrChange|tcPrChange|trPrChange)$/.test(n.name)) return 'revisiones pendientes';
    if (n.name === 'w:fldSimple' || n.name === 'w:instrText' || (!allowFormField && n.name === 'w:fldChar')) return 'campo automático';
    if (n.name === 'mc:AlternateContent') return 'contenido alternativo';
    if (n.name === 'w:sdt') {
      const pr = X.child(n, 'w:sdtPr');
      const lock = pr && X.child(pr, 'w:lock');
      if (lock && X.attr(xml, lock, 'w:val') !== 'unlocked') return 'control bloqueado';
      if (pr && X.child(pr, 'w:dataBinding')) return 'control vinculado a datos';
    }
    if (['w:vanish', 'w:webHidden'].includes(n.name) && !/^(?:0|false|off)$/i.test(X.attr(xml, n, 'w:val') || '')) return 'texto oculto';
    return null;
  };
  let reason = unsafe(node);
  for (let p = node.parent; p && !reason; p = p.parent) reason = unsafe(p);
  X.walk(node, (n) => { reason ||= unsafe(n); return !reason; });
  return reason;
}

function buildPartModel(part, identify = (base, _node, index) => `${base}${index}`) {
  const xml = part.xml;
  const root = X.scan(xml);
  const body = bodyOf(root);
  const prefix = partPrefix(part.label);
  const paragraphs = [];
  const tables = [];
  const sdts = [];
  const checkboxes = [];
  const byId = new Map();
  const tableIndexByNode = new Map();
  const paragraphIndexByNode = new Map();

  const allTables = X.descendants(body, 'w:tbl');
  allTables.forEach((tbl, ti) => {
    const id = identify(`${prefix}t`, tbl, ti);
    tableIndexByNode.set(tbl, id);
    const rows = X.childrenNamed(tbl, 'w:tr').map((tr, ri) => {
      const rowId = identify(`${id}.r`, tr, ri);
      const cells = X.childrenNamed(tr, 'w:tc').map((tc, ci) => {
        const tcPr = X.child(tc, 'w:tcPr');
        const span = tcPr && X.child(tcPr, 'w:gridSpan');
        const vMerge = tcPr && X.child(tcPr, 'w:vMerge');
        const shd = tcPr && X.child(tcPr, 'w:shd');
        return {
          id: identify(`${rowId}.c`, tc, ci),
          node: tc,
          row: ri,
          col: ci,
          gridSpan: span ? Number(X.attr(xml, span, 'w:val')) || 1 : 1,
          vMerge: vMerge ? (X.attr(xml, vMerge, 'w:val') === 'restart' ? 'restart' : 'continue') : null,
          fill: shd ? X.attr(xml, shd, 'w:fill') : null,
          paragraphs: [],
          tables: [],
        };
      });
      return { id: rowId, node: tr, index: ri, cells };
    });
    const table = { id, node: tbl, rows, parentCell: null };
    tables.push(table);
    byId.set(id, { type: 'table', table });
    for (const row of rows) {
      byId.set(row.id, { type: 'row', table, row });
      for (const cell of row.cells) byId.set(cell.id, { type: 'cell', table, row, cell });
    }
  });
  const cellByNode = new Map();
  for (const table of tables) for (const row of table.rows) for (const cell of row.cells) cellByNode.set(cell.node, cell);
  for (const table of tables) {
    const tc = nearest(table.node, 'w:tc');
    if (tc && cellByNode.has(tc)) {
      table.parentCell = cellByNode.get(tc).id;
      cellByNode.get(tc).tables.push(table.id);
    }
  }

  X.descendants(body, 'w:p').forEach((p, pi) => {
    const id = identify(`${prefix}p`, p, pi);
    paragraphIndexByNode.set(p, id);
    const runs = paragraphRuns(p).map((run) => ({ node: run, segments: runSegments(xml, run), format: runFormat(xml, run) }));
    let text = '';
    const map = [];
    for (const run of runs) {
      for (const seg of run.segments) {
        seg.start = text.length;
        text += seg.text;
        seg.end = text.length;
        map.push({ run, seg });
      }
    }
    const tc = nearest(p, 'w:tc');
    const cell = tc ? cellByNode.get(tc) : null;
    const inTextbox = Boolean(nearest(p, 'w:txbxContent'));
    const para = {
      id,
      node: p,
      text,
      runs,
      map,
      props: paragraphProps(xml, p),
      cell: cell ? cell.id : null,
      textbox: inTextbox,
      protectedReason: protectedReason(xml, p),
      hasObject: runs.some((r) => r.segments.some((s) => s.kind === 'object')),
    };
    if (cell) cell.paragraphs.push(id);
    paragraphs.push(para);
    byId.set(id, { type: 'paragraph', paragraph: para });
  });

  // Complex fields may span several paragraphs (TOCs are common). A result
  // paragraph without its own fldChar still belongs to the automatic field.
  const fieldStack = [];
  const fieldRanges = [];
  for (const fld of X.descendants(body, 'w:fldChar')) {
    const kind = X.attr(xml, fld, 'w:fldCharType');
    if (kind === 'begin') fieldStack.push(fld.start);
    else if (kind === 'end' && fieldStack.length) fieldRanges.push([fieldStack.pop(), fld.end]);
  }
  for (const start of fieldStack) fieldRanges.push([start, xml.length]);
  for (const para of paragraphs) {
    if (fieldRanges.some(([start, end]) => start < para.node.end && end > para.node.start))
      para.protectedReason ||= 'campo automático';
  }

  X.descendants(body, 'w:sdt').forEach((sdt, si) => {
    const id = identify(`${prefix}sdt`, sdt, si);
    const sdtPr = X.child(sdt, 'w:sdtPr');
    const tag = sdtPr && X.child(sdtPr, 'w:tag');
    const alias = sdtPr && X.child(sdtPr, 'w:alias');
    const cbx = sdtPr && X.child(sdtPr, 'w14:checkbox');
    const content = X.child(sdt, 'w:sdtContent');
    const paras = content ? X.descendants(content, 'w:p').map((n) => paragraphIndexByNode.get(n)).filter(Boolean) : [];
    const runLevel = content ? paragraphRuns(content) : [];
    let text = '';
    if (paras.length) text = paras.map((pid) => byId.get(pid).paragraph.text).join('\n');
    else for (const run of runLevel) for (const seg of runSegments(xml, run)) text += seg.text;
    const entry = {
      id,
      node: sdt,
      tag: tag ? X.attr(xml, tag, 'w:val') : null,
      alias: alias ? X.attr(xml, alias, 'w:val') : null,
      checkbox: Boolean(cbx),
      paragraphs: paras,
      text,
      level: paras.length ? 'block' : 'run',
    };
    sdts.push(entry);
    byId.set(id, { type: 'sdt', sdt: entry });
    if (cbx) {
      const checkedNode = X.child(cbx, 'w14:checked');
      const checked = checkedNode ? /^(?:1|true)$/i.test(X.attr(xml, checkedNode, 'w14:val') || '') : false;
      const owner = nearest(sdt, 'w:p');
      checkboxes.push({ kind: 'sdt', sdt: entry, checked, paragraph: owner ? paragraphIndexByNode.get(owner) : null });
    }
  });

  // Legacy form-field checkboxes: w:fldChar begin → w:ffData → w:checkBox.
  for (const fld of X.descendants(body, 'w:fldChar')) {
    const ff = X.child(fld, 'w:ffData');
    const cb = ff && X.child(ff, 'w:checkBox');
    if (!cb) continue;
    const checkedNode = X.child(cb, 'w:checked') || X.child(cb, 'w:default');
    const v = checkedNode ? X.attr(xml, checkedNode, 'w:val') : '0';
    const owner = nearest(fld, 'w:p');
    checkboxes.push({ kind: 'formfield', node: cb, checked: v === null || /^(?:1|true|on)$/i.test(v), paragraph: owner ? paragraphIndexByNode.get(owner) : null });
  }

  // Glyph checkboxes typed into the text (☐ Sí ☒ No).
  for (const para of paragraphs) {
    for (const { seg } of para.map) {
      if (seg.kind !== 't') continue;
      for (let k = 0; k < seg.text.length; k += 1) {
        const ch = seg.text[k];
        if (CHECKBOX_GLYPHS.has(ch)) {
          const insideSdt = checkboxes.some((c) => c.kind === 'sdt' && c.paragraph === para.id);
          if (!insideSdt) {
            checkboxes.push({ kind: 'glyph', node: seg.node, glyphIndex: k, paragraph: para.id, offset: seg.start + k, glyph: ch, checked: CHECKBOX_GLYPHS.get(ch), label: para.text.slice(seg.start + k + 1, seg.start + k + 40).trim() });
          }
        }
      }
    }
  }
  checkboxes.forEach((cb, i) => {
    cb.id = identify(`${prefix}cb`, cb.node || cb.sdt.node, i, cb.kind === 'glyph' ? `:${cb.glyphIndex}` : '');
    byId.set(cb.id, { type: 'checkbox', checkbox: cb });
  });

  return { part, xml, root, body, prefix, paragraphs, tables, sdts, checkboxes, byId, tableIndexByNode, paragraphIndexByNode };
}

function cellText(model, cell) {
  return cell.paragraphs.map((pid) => model.byId.get(pid).paragraph.text).join('\n');
}

function fmtTag(fmt = {}) {
  const bits = [];
  if (fmt.bold) bits.push('negrita');
  if (fmt.italic) bits.push('cursiva');
  if (fmt.underline) bits.push('subrayado');
  if (fmt.sizePt) bits.push(`${fmt.sizePt}pt`);
  if (fmt.font) bits.push(fmt.font);
  if (fmt.color) bits.push(`#${fmt.color}`);
  if (fmt.highlight) bits.push(`resaltado:${fmt.highlight}`);
  return bits.join(', ');
}

function dominantFormat(para) {
  const textRuns = para.runs.filter((r) => r.segments.some((s) => s.kind === 't' && s.text.trim()));
  if (!textRuns.length) return {};
  const first = textRuns[0].format;
  const allBold = textRuns.every((r) => r.format.bold);
  return { ...first, bold: allBold || undefined };
}

function clip(text, max) {
  const t = String(text || '').replace(/\n/g, ' ⏎ ').replace(/\t/g, ' ⇥ ');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Compact outline in reading order: paragraphs outside tables, then each table
 * as a grid of cells. Headers/footers come first so the model sees the whole
 * page. `maxChars` bounds the output; `from` skips the first N lines.
 */
function outlineLines(model, { textWidth = 110 } = {}) {
  const lines = [];
  const emitParagraph = (para, indent = '') => {
    const fmt = fmtTag(dominantFormat(para));
    const props = [para.props.style && `estilo ${para.props.style}`, para.props.align && `alineación ${para.props.align}`, para.props.list && 'lista', para.hasObject && 'contiene imagen', para.protectedReason && `no editable: ${para.protectedReason}`, para.textbox && 'cuadro de texto']
      .filter(Boolean).join(', ');
    const meta = [fmt, props].filter(Boolean).join('; ');
    lines.push(`${indent}${para.id}: ${para.text.trim() ? `"${clip(para.text, textWidth)}"` : '(vacío)'}${meta ? `  [${meta}]` : ''}`);
  };
  const emitTable = (table, indent = '') => {
    const nCols = Math.max(0, ...table.rows.map((r) => r.cells.length));
    lines.push(`${indent}${table.id}: TABLA ${table.rows.length} filas × ${nCols} celdas máx.`);
    for (const row of table.rows) {
      const cells = row.cells.map((cell) => {
        const text = cellText(model, cell).trim();
        const firstPara = cell.paragraphs.length ? model.byId.get(cell.paragraphs[0]).paragraph : null;
        const bold = firstPara && text && dominantFormat(firstPara).bold ? '*' : '';
        const span = cell.gridSpan > 1 ? `⟷${cell.gridSpan}` : '';
        const merge = cell.vMerge === 'continue' ? '↑fusionada' : '';
        const label = text ? `${bold}"${clip(text, 60)}"` : '∅';
        return `${cell.id.split('.').pop()}${span}${merge ? ` ${merge}` : ''}=${label}`;
      });
      lines.push(`${indent}  ${row.id.split('.').pop()}: ${cells.join(' | ')}`);
      for (const cell of row.cells) for (const nested of cell.tables) emitTable(model.byId.get(nested).table, `${indent}    `);
    }
  };
  const tableSeen = new Set();
  const walkBlocks = (node, indent) => {
    for (const c of node.children) {
      if (c.name === 'w:p') {
        const id = model.paragraphIndexByNode.get(c);
        const para = id && model.byId.get(id).paragraph;
        if (para && !para.cell) emitParagraph(para, indent);
      } else if (c.name === 'w:tbl') {
        const id = model.tableIndexByNode.get(c);
        if (id && !tableSeen.has(id)) {
          tableSeen.add(id);
          emitTable(model.byId.get(id).table, indent);
        }
      } else if (c.name === 'w:sdt' || c.name === 'w:sdtContent' || c.name === 'w:customXml') {
        walkBlocks(c, indent);
      }
    }
  };
  walkBlocks(model.body, '');
  const floating = model.paragraphs.filter((para) => para.textbox && !para.cell && para.text.trim());
  if (floating.length) {
    lines.push('CUADROS DE TEXTO / FORMAS:');
    for (const para of floating) emitParagraph(para, '  ');
  }
  for (const sdt of model.sdts) {
    if (sdt.checkbox) continue;
    lines.push(`${sdt.id}: CONTROL DE CONTENIDO${sdt.alias ? ` «${sdt.alias}»` : ''}${sdt.tag ? ` tag=${sdt.tag}` : ''} = ${sdt.text.trim() ? `"${clip(sdt.text, 60)}"` : '∅'}`);
  }
  for (const cb of model.checkboxes) {
    lines.push(`${cb.id}: CASILLA ${cb.checked ? '☒ marcada' : '☐ sin marcar'} (${cb.kind}) en ${cb.paragraph || '?'}${cb.label ? ` «${clip(cb.label, 40)}»` : ''}`);
  }
  return lines;
}

module.exports = {
  buildPartModel,
  outlineLines,
  cellText,
  dominantFormat,
  runFormat,
  paragraphRuns,
  runSegments,
  fmtTag,
  clip,
  CHECKBOX_GLYPHS,
  protectedReason,
};
