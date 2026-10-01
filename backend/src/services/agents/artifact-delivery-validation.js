'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { XMLParser, XMLValidator } = require('fast-xml-parser');
const { formatSpec, normalizeFormat } = require('./artifact-format-registry');
const { assertBoundedOfficePackage } = require('../document-editing/edit-output-proof');
const { parseRtf } = require('../rtf-parser');
const { collectRids, collectRelsIds, relsPathForPart } = require('../doc-engine/ooxml');
const MAX_XML_BYTES = 8 * 1024 * 1024;
const MAX_STRUCTURED_TEXT_BYTES = 2 * 1024 * 1024;
const readerProofs = new WeakMap();
function bindArtifactReadback(validation, format, buffer) {
  if (!validation || validation.passed !== true || !Buffer.isBuffer(buffer)) throw new Error('artifact_readback_failed');
  readerProofs.set(validation, { format: normalizeFormat(format), sha256: crypto.createHash('sha256').update(buffer).digest('hex') });
  return validation;
}
function hasArtifactReadback(validation, format, buffer) {
  if (!Buffer.isBuffer(buffer) || validation?.passed === false || validation?.ok === false) return false;
  const proof = readerProofs.get(validation) || readerProofs.get(validation?.structure);
  return Boolean(proof && proof.format === normalizeFormat(format) && proof.sha256 === crypto.createHash('sha256').update(buffer).digest('hex'));
}

function failure(format, reason) {
  return { ok: false, passed: false, format, reason, code: 'E_PARAMS', engine: 'artifact_format_reader',
    scope: 'file_structure_only', technicalScore: 0, qualityScore: 0, overallScore: 0, error: reason === 'format_unsupported'
    ? `No hay un verificador disponible para .${format || 'bin'}. Usa un formato compatible; no se ha validado este archivo.`
      : reason === 'format_reader_required'
        ? `El entorno todavía no puede verificar archivos .${format}. Usa un formato compatible; no se ha validado este archivo.`
        : `El archivo .${format} está incompleto, dañado o no corresponde al formato solicitado. Regenera el archivo con su formato real.` };
}
function success(spec, buffer, summary, readback = true) {
  const verdict = { ok: true, passed: true, format: spec.format, mime: spec.mime, engine: 'artifact_format_reader',
    scope: spec.family === 'statistical_syntax' ? 'text_readability_only' : 'file_structure_only',
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    sizeBytes: buffer.length, technicalScore: 100, summary };
  return readback ? bindArtifactReadback(verdict, spec.format, buffer) : verdict;
}
function readableText(buffer) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  if (!text.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new Error('text_unreadable');
  return text;
}
function validateNamespaces(parsed) {
  const pending = Object.entries(parsed).filter(([key]) => !key.startsWith('?')).map(([name, node]) => ({ name, node, namespaces: { xml: 'http://www.w3.org/XML/1998/namespace' }, depth: 1 }));
  while (pending.length) {
    const { name, node, namespaces, depth } = pending.pop();
    if (depth > 256) throw new Error('xml_depth_limit');
    const scope = { ...namespaces };
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === '@_xmlns') scope[''] = value;
        else if (key.startsWith('@_xmlns:')) scope[key.slice(8)] = value;
      }
    }
    if (name.includes(':') && !scope[name.split(':')[0]]) throw new Error('xml_namespace_unbound');
    for (const [key, value] of Object.entries(node && typeof node === 'object' ? node : {})) {
      if (key.startsWith('@_')) {
        const attribute = key.slice(2);
        if (attribute.includes(':') && !attribute.startsWith('xmlns:') && !scope[attribute.split(':')[0]]) throw new Error('xml_namespace_unbound');
      } else if (!key.startsWith('#') && !key.startsWith('?')) {
        for (const childNode of Array.isArray(value) ? value : [value]) pending.push({ name: key, node: childNode, namespaces: scope, depth: depth + 1 });
      }
    }
  }
}
function xmlDocument(buffer) {
  if (buffer.length > MAX_XML_BYTES) throw new Error('xml_size_limit');
  const text = readableText(buffer);
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text)) throw new Error('xml_external_entities_forbidden');
  if ([...text.matchAll(/&([a-z][\w.-]*);/gi)].some((match) => !['amp', 'lt', 'gt', 'apos', 'quot'].includes(match[1]))) throw new Error('xml_entity_unknown');
  if (XMLValidator.validate(text) !== true) throw new Error('xml_invalid');
  const parsed = new XMLParser({ ignoreAttributes: false, processEntities: false, parseTagValue: false }).parse(text);
  validateNamespaces(parsed);
  const roots = Object.keys(parsed).filter((key) => !key.startsWith('?'));
  if (roots.length !== 1) throw new Error('xml_root_invalid');
  const prefix = roots[0].includes(':') ? roots[0].split(':')[0] : '';
  const node = parsed[roots[0]];
  return { parsed, root: roots[0].split(':').pop(), node, namespace: node?.[prefix ? `@_xmlns:${prefix}` : '@_xmlns'], text };
}
function child(node, name) {
  const key = Object.keys(node || {}).find((key) => !key.startsWith('@_') && key.split(':').pop() === name);
  return key === undefined ? undefined : node[key];
}
function array(value) { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }
function attr(node, name) {
  const key = Object.keys(node || {}).find((key) => key.startsWith('@_') && key.slice(2).split(':').pop() === name);
  return key === undefined ? undefined : node[key];
}
function zipPart(zip, name) {
  const file = zip.file(name);
  if (!file) throw new Error('package_part_missing');
  return file.asNodeBuffer();
}
function officeStructure(format, buffer) {
  const zip = assertBoundedOfficePackage(buffer);
  const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir);
  // CRC-valid ZIP bytes still do not prove an XML document is readable.
  for (const name of names.filter((name) => /\.(?:xml|rels)$/i.test(name))) xmlDocument(zipPart(zip, name));
  for (const name of names.filter((name) => /\.xml$/i.test(name) && name !== '[Content_Types].xml')) {
    const ids = collectRids(zipPart(zip, name).toString('utf8'));
    if (!ids.length) continue;
    const rels = zipPart(zip, relsPathForPart(name));
    const known = collectRelsIds(rels.toString('utf8'));
    if (ids.some((id) => !known.has(id))) throw new Error('ooxml_relationship_missing');
  }
  for (const name of names.filter((name) => /\.rels$/i.test(name))) {
    const rels = xmlDocument(zipPart(zip, name));
    if (rels.root !== 'Relationships') throw new Error('ooxml_relationships_invalid');
    const base = name === '_rels/.rels' ? '' : path.posix.dirname(path.posix.dirname(name));
    for (const rel of array(child(rels.node, 'Relationship'))) {
      if (attr(rel, 'TargetMode') === 'External') continue;
      const target = String(attr(rel, 'Target') || '').split('#')[0];
      const resolved = path.posix.normalize(target.startsWith('/') ? target.slice(1) : path.posix.join(base, target));
      if (!target || resolved.startsWith('../') || !zip.file(resolved)) throw new Error('ooxml_relationship_target_missing');
    }
  }
  const types = xmlDocument(zipPart(zip, '[Content_Types].xml'));
  if (types.root !== 'Types') throw new Error('ooxml_content_types_invalid');
  const main = {
    docx: ['word/document.xml', 'document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'],
    xlsx: ['xl/workbook.xml', 'workbook', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'],
    pptx: ['ppt/presentation.xml', 'presentation', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'],
  }[format];
  const matchedType = array(child(types.node, 'Override')).some((item) => attr(item, 'PartName') === `/${main[0]}` && attr(item, 'ContentType') === main[2]);
  if (!matchedType) throw new Error('ooxml_format_mismatch');
  const doc = xmlDocument(zipPart(zip, main[0]));
  const namespaceKind = { docx: 'wordprocessingml', xlsx: 'spreadsheetml', pptx: 'presentationml' }[format];
  if (doc.root !== main[1] || ![`http://schemas.openxmlformats.org/${namespaceKind}/2006/main`, `http://purl.oclc.org/ooxml/${namespaceKind}/main`].includes(doc.namespace)) throw new Error('ooxml_root_invalid');
  const rootRels = xmlDocument(zipPart(zip, '_rels/.rels'));
  if (!array(child(rootRels.node, 'Relationship')).some((rel) => String(attr(rel, 'Type')).endsWith('/officeDocument') && String(attr(rel, 'Target')).replace(/^\//, '') === main[0])) throw new Error('ooxml_main_relationship_missing');
  if (format === 'docx' && child(doc.node, 'body') === undefined) throw new Error('docx_body_missing');
  if (format === 'xlsx') {
    const sheets = array(child(child(doc.node, 'sheets'), 'sheet'));
    if (!sheets.length || !names.some((name) => /^xl\/worksheets\/[^/]+\.xml$/.test(name))) throw new Error('xlsx_sheets_missing');
    const sharedStrings = zip.file('xl/sharedStrings.xml')
      ? array(child(xmlDocument(zipPart(zip, 'xl/sharedStrings.xml')).node, 'si')).length : 0;
    const { splitCellRef } = require('../document-editing/xlsx-adapter');
    const checkedCoordinate = (ref) => {
      const raw = String(ref || '').replace(/\$/g, '');
      if (!/^[A-Za-z]{1,3}\d{1,7}$/.test(raw)) throw new Error('xlsx_coordinate_invalid');
      const point = splitCellRef(raw);
      if (!point || !Number.isSafeInteger(point.row) || point.row < 1 || point.row > 1048576
        || point.colIndex < 1 || point.colIndex > 16384) throw new Error('xlsx_coordinate_invalid');
      return point;
    };
    let cellCount = 0; let mergedCellBudget = 0;
    for (const name of names.filter((name) => /^xl\/worksheets\/[^/]+\.xml$/.test(name))) {
      const sheet = xmlDocument(zipPart(zip, name));
      if (sheet.root !== 'worksheet' || child(sheet.node, 'sheetData') === undefined) throw new Error('xlsx_worksheet_invalid');
      for (const row of array(child(child(sheet.node, 'sheetData'), 'row'))) {
        for (const cell of array(child(row, 'c'))) {
          if (++cellCount + mergedCellBudget > 200_000) throw new Error('xlsx_cell_budget');
          if (attr(cell, 'r')) checkedCoordinate(attr(cell, 'r'));
          const type = attr(cell, 't') || 'n'; const value = child(cell, 'v');
          if (!['n', 'b', 's', 'str', 'inlineStr', 'e', 'd'].includes(type)) throw new Error('xlsx_cell_type_invalid');
          if (value !== undefined && value !== '') {
            if (type === 'n' && (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(String(value)) || !Number.isFinite(Number(value)))) throw new Error('xlsx_numeric_cell_invalid');
            if (type === 'b' && !['0', '1'].includes(String(value))) throw new Error('xlsx_boolean_cell_invalid');
            if (type === 's' && (!/^\d+$/.test(String(value)) || Number(value) >= sharedStrings)) throw new Error('xlsx_string_reference_invalid');
            if (type === 'd' && !Number.isFinite(Date.parse(String(value)))) throw new Error('xlsx_date_cell_invalid');
          }
        }
      }
      // openpyxl expands merged coordinates during load_workbook, before the
      // reader can count cells. Bound that allocation in the XML prefilter.
      for (const merge of array(child(child(sheet.node, 'mergeCells'), 'mergeCell'))) {
        const range = String(attr(merge, 'ref') || '').split(':');
        if (range.length < 1 || range.length > 2) throw new Error('xlsx_merge_range_invalid');
        const start = checkedCoordinate(range[0]); const end = checkedCoordinate(range[1] || range[0]);
        if (end.row < start.row || end.colIndex < start.colIndex) throw new Error('xlsx_merge_range_invalid');
        mergedCellBudget += (end.row - start.row + 1) * (end.colIndex - start.colIndex + 1);
        if (cellCount + mergedCellBudget > 200_000) throw new Error('xlsx_cell_budget');
      }
      for (const column of array(child(child(sheet.node, 'cols'), 'col'))) {
        const min = Number(attr(column, 'min')); const max = Number(attr(column, 'max'));
        if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 1 || max < min || max > 16384) throw new Error('xlsx_column_range_invalid');
      }
    }
    return { sheetCount: sheets.length, cellCount, sheets: sheets.map((item) => ({ name: attr(item, 'name') })).slice(0, 100) };
  }
  if (format === 'pptx') {
    const slides = array(child(child(doc.node, 'sldIdLst'), 'sldId'));
    if (!slides.length || !names.some((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))) throw new Error('pptx_slides_missing');
    for (const name of names.filter((name) => /^ppt\/slides\/[^/]+\.xml$/.test(name))) {
      const slide = xmlDocument(zipPart(zip, name));
      const tree = child(child(slide.node, 'cSld'), 'spTree');
      if (slide.root !== 'sld' || tree === undefined || child(tree, 'nvGrpSpPr') === undefined || child(tree, 'grpSpPr') === undefined) throw new Error('pptx_slide_tree_invalid');
    }
    return { slideCount: slides.length };
  }
  return { partCount: names.length };
}
function odfStructure(spec, buffer) {
  const zip = assertBoundedOfficePackage(buffer);
  if (buffer.readUInt32LE(0) !== 0x04034b50 || buffer.readUInt16LE(8) !== 0 || buffer.readUInt16LE(26) !== 8
    || buffer.readUInt16LE(28) !== 0 || buffer.subarray(30, 38).toString() !== 'mimetype') throw new Error('odf_mimetype_entry_invalid');
  if (zipPart(zip, 'mimetype').toString('utf8') !== spec.mime) throw new Error('odf_format_mismatch');
  const manifest = xmlDocument(zipPart(zip, 'META-INF/manifest.xml'));
  const content = xmlDocument(zipPart(zip, 'content.xml'));
  if (manifest.root !== 'manifest' || manifest.namespace !== 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0'
    || content.root !== 'document-content' || content.namespace !== 'urn:oasis:names:tc:opendocument:xmlns:office:1.0') throw new Error('odf_root_invalid');
  const entries = array(child(manifest.node, 'file-entry'));
  if (!entries.some((entry) => attr(entry, 'full-path') === '/' && attr(entry, 'media-type') === spec.mime)
    || !entries.some((entry) => attr(entry, 'full-path') === 'content.xml' && attr(entry, 'media-type') === 'text/xml')) throw new Error('odf_manifest_mismatch');
  const kind = { odt: 'text', ods: 'spreadsheet', odp: 'presentation' }[spec.format];
  if (child(child(content.node, 'body'), kind) === undefined) throw new Error('odf_body_mismatch');
  // Read all XML parts: a corrupted style part must not hide behind valid content.xml.
  for (const name of Object.keys(zip.files).filter((name) => !zip.files[name].dir && /\.xml$/i.test(name))) xmlDocument(zipPart(zip, name));
  return { documentKind: kind, partCount: Object.keys(zip.files).length };
}
function rtfStructure(buffer) {
  const text = buffer.toString('latin1');
  if (!/^\{\\rtf[1-9]\d*\b/.test(text)) throw new Error('rtf_header_invalid');
  let depth = 0; let closed = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (closed && !/\s/.test(char)) throw new Error('rtf_trailing_data');
    if (char === '\\') {
      if (++i >= text.length) throw new Error('rtf_truncated');
      if (text[i] === "'") {
        if (!/^[0-9a-f]{2}$/i.test(text.slice(i + 1, i + 3))) throw new Error('rtf_escape_invalid');
        i += 2;
      } else if (/[a-z]/i.test(text[i])) {
        const control = text.slice(i).match(/^([a-z]+)(-?\d+)? ?/i);
        i += control[0].length - 1;
        if (control[1].toLowerCase() === 'bin') {
          const size = Number(control[2]);
          if (!Number.isSafeInteger(size) || size < 0 || i + size >= text.length) throw new Error('rtf_binary_truncated');
          i += size;
        }
      }
    } else if (char === '{') {
      if (++depth > 256) throw new Error('rtf_group_limit');
    } else if (char === '}') {
      if (--depth < 0) throw new Error('rtf_group_invalid');
      if (depth === 0) closed = true;
    }
  }
  if (!closed || depth !== 0) throw new Error('rtf_truncated');
  const readback = parseRtf(text);
  return { charCount: readback.length, firstChars: readback.slice(0, 240) };
}
function csvStructure(buffer) {
  const text = readableText(buffer); const rows = []; let row = []; let cell = ''; let quoted = false; let closed = false;
  const counts = new Map([[',', 0], [';', 0], ['\t', 0]]); let inHeaderQuote = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') {
      if (inHeaderQuote && text[i + 1] === '"') i++;
      else inHeaderQuote = !inHeaderQuote;
    } else if (!inHeaderQuote) {
      if (text[i] === '\n' || text[i] === '\r') break;
      if (counts.has(text[i])) counts.set(text[i], counts.get(text[i]) + 1);
    }
  }
  const delimiter = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a))[0];
  const addRow = () => { row.push(cell); if (row.some((value) => value !== '')) rows.push(row); row = []; cell = ''; closed = false; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else cell += c;
    } else if (c === delimiter) { row.push(cell); cell = ''; closed = false; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; addRow(); }
    else if (c === '"' && cell === '' && !closed) quoted = true;
    else { if (closed || c === '"') throw new Error('csv_quote_invalid'); cell += c; }
  }
  if (quoted) throw new Error('csv_quote_unclosed');
  if (cell || row.length) addRow();
  if (!rows.length || rows.some((item) => item.length !== rows[0].length)) throw new Error('csv_columns_inconsistent');
  return { rowCount: Math.max(0, rows.length - 1), columnCount: rows[0].length, columns: rows[0].slice(0, 100), lineCount: rows.length };
}

function validateArtifactStructure(format, buffer) {
  const ext = normalizeFormat(format); const spec = formatSpec(ext);
  if (!spec) return failure(ext, 'format_unsupported');
  if (!Buffer.isBuffer(buffer) || !buffer.length) return failure(ext, 'empty_file');
  try {
    if (['json', 'html', 'yaml', 'xml', 'svg'].includes(spec.family) && buffer.length > MAX_STRUCTURED_TEXT_BYTES) throw new Error('structured_text_size_limit');
    let summary;
    if (spec.family === 'office') summary = officeStructure(ext, buffer);
    else if (spec.family === 'odf') summary = odfStructure(spec, buffer);
    else if (spec.family === 'rtf') summary = rtfStructure(buffer);
    else if (spec.family === 'zip') { const zip = assertBoundedOfficePackage(buffer); summary = { entryCount: Object.keys(zip.files).length }; }
    else if (ext === 'wav') {
      summary = require('./artifact-media-validation').readPcmWav(buffer);
      if (!summary) return failure(ext, 'format_reader_required');
    }
    else if (spec.family === 'json') {
      const data = JSON.parse(readableText(buffer));
      summary = Array.isArray(data) ? { arrayLength: data.length } : data && typeof data === 'object' ? { topLevelKeys: Object.keys(data).slice(0, 100) } : { scalarType: data === null ? 'null' : typeof data };
    } else if (spec.family === 'yaml') {
      let depth = 0; let nodes = 0;
      const docs = require('js-yaml').loadAll(readableText(buffer), undefined, { schema: require('js-yaml').JSON_SCHEMA,
        listener(event) {
          if (event === 'open' && (++depth > 64 || ++nodes > 100_000)) throw new Error('yaml_structure_limit');
          if (event === 'close') depth--;
        },
      });
      summary = { documentCount: docs.length };
    } else if (spec.family === 'csv') summary = csvStructure(buffer);
    else if (['xml', 'svg'].includes(spec.family)) {
      const parsed = xmlDocument(buffer);
      const decoded = parsed.text.replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (_, hex, decimal) => {
        const code = Number.parseInt(hex || decimal, hex ? 16 : 10);
        return code <= 0x10ffff ? String.fromCodePoint(code) : '';
      }).replace(/[\t\r\n]/g, '');
      if (spec.family === 'svg' && (parsed.root !== 'svg' || parsed.namespace !== 'http://www.w3.org/2000/svg'
        || /<(?:[\w.-]+:)?(?:script|foreignObject|animate|animateTransform|animateMotion|set)\b|\son[\w-]+\s*=|(?:href|src)\s*=\s*["']?\s*(?:javascript|data|https?):|@import\b|url\(\s*["']?\s*(?!#)/i.test(decoded))) throw new Error('svg_active_content_or_invalid_root');
      summary = { root: parsed.root, charCount: parsed.text.length };
    } else if (spec.family === 'html') {
      const text = readableText(buffer);
      if (!/<html(?:\s|>)/i.test(text) || !/<body(?:\s|>)/i.test(text) || !/<\/html\s*>/i.test(text) || !/<\/body\s*>/i.test(text)) throw new Error('html_document_incomplete');
      const $ = require('cheerio').load(text, { sourceCodeLocationInfo: true });
      if (!$('html')[0]?.sourceCodeLocation?.startTag || !$('html')[0]?.sourceCodeLocation?.endTag
        || !$('body')[0]?.sourceCodeLocation?.startTag || !$('body')[0]?.sourceCodeLocation?.endTag) throw new Error('html_document_incomplete');
      summary = { title: $('title').first().text().slice(0, 200), charCount: $('body').text().length };
    } else if (['text', 'statistical_syntax'].includes(spec.family)) {
      const text = readableText(buffer); summary = { charCount: text.length, lineCount: text.split(/\r?\n/).length, firstChars: text.slice(0, 240) };
      if (spec.family === 'statistical_syntax') summary.syntaxExecuted = false;
    } else return failure(ext, 'format_reader_required');
    // Office XML is a prefilter. A private Office readback proof is created
    // only by the specific reader below, never by ZIP/XML part counts.
    return success(spec, buffer, summary, spec.family !== 'office');
  } catch (error) { return failure(ext, error.code || (error instanceof SyntaxError ? `${ext}_parse_invalid` : error.message) || 'format_unreadable'); }
}

async function validateArtifactBytes(format, buffer, options = {}) {
  const ext = normalizeFormat(format); const spec = formatSpec(ext);
  if (!spec || !Buffer.isBuffer(buffer) || !buffer.length) return validateArtifactStructure(ext, buffer);
  try {
    if (hasArtifactReadback(options.validation, ext, buffer)) {
      return success(spec, buffer, options.validation.structure?.summary || options.validation.summary || {});
    }
    if (spec.family === 'office') {
      const structure = validateArtifactStructure(ext, buffer);
      if (!structure.passed) return structure;
      const reader = await require('./artifact-office-readback').readOffice(ext, buffer, options);
      if (!reader.ok) return failure(ext, reader.reason);
      return success(spec, buffer, { ...structure.summary, ...reader.summary });
    }
    if (spec.family === 'pdf') {
      if (buffer.subarray(0, 5).toString() !== '%PDF-') return failure(ext, 'pdf_header_invalid');
      const readable = await require('../doc-agent/pdf-output-validation').validateEditedPdf({ editedBuffer: buffer });
      if (!readable.ok) return failure(ext, readable.reason);
      const pdf = await require('pdf-lib').PDFDocument.load(buffer, { throwOnInvalidObject: true });
      if (pdf.isEncrypted || pdf.getPageCount() < 1) return failure(ext, 'pdf_unreadable');
      return success(spec, buffer, { pageCount: pdf.getPageCount() });
    }
    if (spec.family === 'image' && ext !== 'ico') {
      const image = require('sharp')(buffer, { animated: true, failOn: 'warning', limitInputPixels: 40_000_000 });
      const metadata = await image.metadata();
      if ((ext === 'jpg' ? 'jpeg' : ext) !== metadata.format) return failure(ext, 'image_format_mismatch');
      await image.stats(); // Decode pixel data too; a matching header is insufficient.
      return success(spec, buffer, { width: metadata.width, height: metadata.height });
    }
    if (ext === 'ico') return success(spec, buffer, await require('./artifact-media-validation').readIco(buffer));
    if (spec.family === 'media') return success(spec, buffer, await require('./artifact-media-validation').readMedia(ext, buffer));
    return validateArtifactStructure(ext, buffer);
  } catch (error) { return failure(ext, error.code === 'MEDIA_TOOL_UNAVAILABLE' ? 'format_reader_required' : `${spec.family}_unreadable`); }
}
module.exports = { validateArtifactStructure, validateArtifactBytes, hasArtifactReadback, bindArtifactReadback };
