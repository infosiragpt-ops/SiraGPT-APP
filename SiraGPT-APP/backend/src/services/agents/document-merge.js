'use strict';

/**
 * document-merge — Cowork-style deterministic DOCX merging.
 *
 * "Subo 2 Words y me devuelve 1 Word": the merge itself must NOT depend on an
 * LLM calling the right tool with the right script (weak models don't). This
 * module gives the chat a deterministic path:
 *
 *   1. `isDocumentMergeRequest(text, { fileCount })` — bilingual intent
 *      detector ("combina / fusiona / une / junta / merge ... en un solo
 *      word"). With 2+ attached files a bare pronoun form ("únelos",
 *      "combínalos") is enough — the attachments are the only plausible target.
 *   2. `mergeDocxBuffers(files)` — real OOXML body merge: the first document
 *      is the base container (keeps its styles/numbering/media); every
 *      following document's <w:body> content is appended after a page break,
 *      with its images/hyperlinks re-linked (relationship IDs remapped, media
 *      parts copied, content-type defaults added). Output opens in Word,
 *      Google Docs and LibreOffice — no altChunk.
 *   3. `mergeFromExtractedText(files)` — fallback when a source isn't a valid
 *      OOXML zip: rebuilds a clean .docx from the already-extracted text.
 *
 * Pure Node (PizZip + docx), no sandbox, no network — offline-testable.
 */

const PizZip = require('pizzip');
const { Document, Packer, Paragraph, HeadingLevel, TextRun, PageBreak } = require('docx');

// ─── Intent detection ────────────────────────────────────────────────────────

// Merge/combine verb stems (ES + EN). Word-boundary on the left; stems keep
// conjugations matching (fusiona / fusionar / fusióname, combine / combining).
const MERGE_VERBS = new RegExp(
  '\\b(' +
    [
      // Spanish
      'fusion', 'combin', 'unific', 'consolid', 'mezcl', 'integr', 'concaten',
      'junta', 'j[uú]nta', 'juntar', 'une', '[uú]ne', 'unir', '[uú]nelos', '[uú]nelas',
      // English
      'merge', 'merg', 'combine', 'combining', 'join', 'unify', 'consolidat', 'concatenat',
    ].join('|') +
    ')',
  'i',
);

// Nouns that make a merge target unambiguous without attachments.
const MERGE_TARGET_NOUNS = /\b(word|docx?|documentos?|documents?|archivos?|files?|informes?|reportes?|reports?|pdfs?|textos?|escritos?|adjuntos?|attachments?)\b/i;

// "…into ONE file" phrasings that signal a merge even with weak verbs:
// "en un solo word", "en uno solo", "in a single document", "hazlos uno".
const INTO_ONE = /\b(en\s+(un|1)\s+(solo\s+|[uú]nico\s+)?(word|docx?|documento|archivo|pdf|informe|reporte|texto)|en\s+uno\s+solo|hazlos?\s+uno|un\s+solo\s+(word|docx?|documento|archivo)|into\s+(a\s+)?(single|one)\s+(word|docx?|document|file)|as\s+one\s+(document|file))\b/i;

// "2 words → 1 word" style: a couple of digits + doc nouns.
const TWO_TO_ONE = /\b([2-9]|dos|tres|cuatro|two|three|four)\s+(words?|docx?s?|documentos?|documents?|archivos?|files?)\b[\s\S]{0,60}\b(1|un[oa]?|one)\b/i;

/**
 * @param {string} text user message
 * @param {{fileCount?: number}} [opts] number of files attached to the turn
 * @returns {boolean}
 */
function isDocumentMergeRequest(text, opts = {}) {
  // Strip accents first: JS \b is ASCII-only, so "únelos"/"único" would never
  // hit a left word-boundary otherwise.
  const t = String(text == null ? '' : text).trim().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (!t) return false;
  const fileCount = Number(opts.fileCount) || 0;
  if (INTO_ONE.test(t) && (MERGE_VERBS.test(t) || MERGE_TARGET_NOUNS.test(t) || fileCount >= 2)) return true;
  if (TWO_TO_ONE.test(t) && (MERGE_VERBS.test(t) || fileCount >= 2)) return true;
  if (!MERGE_VERBS.test(t)) return false;
  // With 2+ attachments a pronoun-only imperative ("combínalos", "únelos",
  // "fusiónalos", "merge them") can only mean the attached files.
  if (fileCount >= 2) {
    return MERGE_TARGET_NOUNS.test(t) || /\b(los|las|them|ambos|ambas|estos|estas|these|both|todo)\b/i.test(t) || /l[oa]s\b|melos\b|malos\b/i.test(t) || t.length <= 80;
  }
  return MERGE_TARGET_NOUNS.test(t);
}

// ─── OOXML helpers ──────────────────────────────────────────────────────────

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function looksLikeZip(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

/** Extract the inner <w:body> content, dropping the trailing body-level sectPr. */
function extractBodyContent(documentXml) {
  const open = documentXml.indexOf('<w:body>');
  const close = documentXml.lastIndexOf('</w:body>');
  if (open === -1 || close === -1) throw new Error('document.xml has no <w:body>');
  let body = documentXml.slice(open + '<w:body>'.length, close);
  // Strip the LAST body-level sectPr (page setup of that source document).
  const sectIdx = body.lastIndexOf('<w:sectPr');
  if (sectIdx !== -1) {
    const sectEnd = body.indexOf('</w:sectPr>', sectIdx);
    if (sectEnd !== -1) {
      body = body.slice(0, sectIdx) + body.slice(sectEnd + '</w:sectPr>'.length);
    } else {
      // self-closing <w:sectPr .../>
      const selfEnd = body.indexOf('/>', sectIdx);
      if (selfEnd !== -1) body = body.slice(0, sectIdx) + body.slice(selfEnd + 2);
    }
  }
  return body;
}

function parseRelationships(relsXml) {
  const rels = new Map();
  if (!relsXml) return rels;
  const re = /<Relationship\b([^>]*)\/?>(?:<\/Relationship>)?/g;
  let m;
  while ((m = re.exec(relsXml)) !== null) {
    const attrs = m[1];
    const id = (attrs.match(/\bId="([^"]+)"/) || [])[1];
    const type = (attrs.match(/\bType="([^"]+)"/) || [])[1];
    const target = (attrs.match(/\bTarget="([^"]+)"/) || [])[1];
    const mode = (attrs.match(/\bTargetMode="([^"]+)"/) || [])[1] || 'Internal';
    if (id && type && target) rels.set(id, { id, type, target, mode });
  }
  return rels;
}

const EXT_CONTENT_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  bmp: 'image/bmp', tiff: 'image/tiff', emf: 'image/x-emf', wmf: 'image/x-wmf',
  svg: 'image/svg+xml', webp: 'image/webp', bin: 'application/octet-stream',
};

/** Ensure [Content_Types].xml has a Default for `ext`. Returns updated xml. */
function ensureDefaultContentType(contentTypesXml, ext) {
  const lower = String(ext || '').toLowerCase();
  if (!lower || new RegExp(`<Default[^>]+Extension="${lower}"`, 'i').test(contentTypesXml)) return contentTypesXml;
  const ct = EXT_CONTENT_TYPES[lower] || 'application/octet-stream';
  return contentTypesXml.replace('</Types>', `<Default Extension="${lower}" ContentType="${ct}"/></Types>`);
}

/**
 * Merge N .docx buffers into one, preserving formatting.
 * The FIRST document is the container (styles/numbering/theme win); the
 * others contribute their body XML + media, appended after page breaks.
 *
 * @param {Array<{name?: string, buffer: Buffer}>} files ≥2 docx buffers, in order
 * @returns {Buffer} merged .docx
 */
function mergeDocxBuffers(files) {
  const sources = (files || []).filter((f) => f && looksLikeZip(f.buffer));
  if (sources.length < 2) throw new Error('mergeDocxBuffers needs at least 2 valid .docx buffers');

  const base = new PizZip(sources[0].buffer);
  const baseDocFile = base.file('word/document.xml');
  if (!baseDocFile) throw new Error(`${sources[0].name || 'doc1'} is not a valid .docx (no word/document.xml)`);
  let baseDoc = baseDocFile.asText();
  let baseRelsXml = base.file('word/_rels/document.xml.rels')
    ? base.file('word/_rels/document.xml.rels').asText()
    : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  let contentTypes = base.file('[Content_Types].xml') ? base.file('[Content_Types].xml').asText() : null;
  if (!contentTypes) throw new Error('base docx has no [Content_Types].xml');

  const PAGE_BREAK = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
  const appendedParts = [];

  for (let i = 1; i < sources.length; i++) {
    const src = sources[i];
    const zip = new PizZip(src.buffer);
    const docFile = zip.file('word/document.xml');
    if (!docFile) throw new Error(`${src.name || `doc${i + 1}`} is not a valid .docx (no word/document.xml)`);
    let body = extractBodyContent(docFile.asText());

    // Re-link every relationship the body references (images, hyperlinks,
    // charts…): copy internal parts under a unique name, register a new rel
    // id in the base, and rewrite the references inside the body XML.
    const srcRels = parseRelationships(zip.file('word/_rels/document.xml.rels') ? zip.file('word/_rels/document.xml.rels').asText() : '');
    const usedIds = new Set();
    const refRe = /\br:(?:id|embed|link|pict|dm|lo|qs|cs)="([^"]+)"/g;
    let rm;
    while ((rm = refRe.exec(body)) !== null) usedIds.add(rm[1]);

    const idMap = new Map();
    for (const relId of usedIds) {
      const rel = srcRels.get(relId);
      if (!rel) continue;
      const newId = `mrg${i}${relId}`;
      let newTarget = rel.target;
      if (rel.mode !== 'External') {
        // Resolve the part path relative to word/ and copy it under a
        // collision-free name inside the base package.
        const srcPath = rel.target.replace(/^\.\//, '').replace(/^\//, '');
        const fullSrcPath = srcPath.startsWith('word/') ? srcPath : `word/${srcPath}`;
        const partFile = zip.file(fullSrcPath);
        if (!partFile) continue;
        const dot = srcPath.lastIndexOf('.');
        const ext = dot !== -1 ? srcPath.slice(dot + 1) : 'bin';
        const stem = dot !== -1 ? srcPath.slice(0, dot) : srcPath;
        newTarget = `${stem}_mrg${i}.${ext}`;
        const fullNewPath = newTarget.startsWith('word/') ? newTarget : `word/${newTarget}`;
        base.file(fullNewPath, partFile.asUint8Array());
        contentTypes = ensureDefaultContentType(contentTypes, ext);
      }
      baseRelsXml = baseRelsXml.replace(
        '</Relationships>',
        `<Relationship Id="${newId}" Type="${rel.type}" Target="${newTarget}"${rel.mode === 'External' ? ' TargetMode="External"' : ''}/></Relationships>`,
      );
      idMap.set(relId, newId);
    }
    if (idMap.size) {
      body = body.replace(/\b(r:(?:id|embed|link|pict|dm|lo|qs|cs)=")([^"]+)(")/g,
        (all, pre, oldId, post) => (idMap.has(oldId) ? `${pre}${idMap.get(oldId)}${post}` : all));
    }
    appendedParts.push(PAGE_BREAK + body);
  }

  // Insert appended bodies right before the base's final sectPr (or </w:body>).
  const appended = appendedParts.join('');
  const baseSect = baseDoc.lastIndexOf('<w:sectPr');
  if (baseSect !== -1) {
    baseDoc = baseDoc.slice(0, baseSect) + appended + baseDoc.slice(baseSect);
  } else {
    baseDoc = baseDoc.replace('</w:body>', `${appended}</w:body>`);
  }

  base.file('word/document.xml', baseDoc);
  base.file('word/_rels/document.xml.rels', baseRelsXml);
  base.file('[Content_Types].xml', contentTypes);
  return base.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ─── Fallback: rebuild from extracted text ──────────────────────────────────

/**
 * Build a clean merged .docx from already-extracted text (formatting lost,
 * content kept). Used when a source buffer isn't a readable OOXML package.
 *
 * @param {Array<{name?: string, text: string}>} docs
 * @param {{title?: string}} [opts]
 * @returns {Promise<Buffer>}
 */
async function mergeFromExtractedText(docs, opts = {}) {
  const children = [];
  if (opts.title) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: String(opts.title), font: 'Calibri' })] }));
  }
  docs.forEach((doc, idx) => {
    if (idx > 0) children.push(new Paragraph({ children: [new PageBreak()] }));
    if (doc.name) {
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: String(doc.name), font: 'Calibri' })] }));
    }
    const blocks = String(doc.text || '').replace(/\r\n/g, '\n').split(/\n{2,}/);
    for (const block of blocks) {
      const line = block.trim();
      if (!line) continue;
      children.push(new Paragraph({ children: [new TextRun({ text: line.replace(/\n/g, ' '), font: 'Calibri' })] }));
    }
  });
  const doc = new Document({
    styles: { default: { document: { run: { font: 'Calibri', size: 22 }, paragraph: { spacing: { line: 300, before: 80, after: 80 } } } } },
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}

/** Suggested output filename for a merged doc. */
function mergedFilename(files) {
  const first = String((files && files[0] && files[0].name) || 'documento').replace(/\.[^.]+$/, '');
  const stem = first.length > 40 ? `${first.slice(0, 40)}…` : first;
  return `${stem} (fusionado).docx`;
}

module.exports = {
  isDocumentMergeRequest,
  mergeDocxBuffers,
  mergeFromExtractedText,
  mergedFilename,
  DOCX_MIME,
  // exported for tests
  _internals: { extractBodyContent, parseRelationships, ensureDefaultContentType, looksLikeZip },
};
