/**
 * pdf-structure — layout-aware structural analysis of a plain-text
 * document (or a "page stream" already extracted from a PDF by
 * pdfjs / pdfplumber).
 *
 * Input is text. Each document is a string OR an array of `{ page, text }`
 * objects (one per page). We do NOT call a PDF runtime here: this module
 * is pure, deterministic, and CI-runnable with zero binary deps.
 *
 * What it produces:
 *   - sections[]: { heading_path[], level, start_page, end_page,
 *                   text, char_start, char_end }
 *   - tables[]:   { page, rows[][], start_line, end_line, confidence }
 *   - figures[]:  { page, caption, kind }
 *   - structured_chunks[]: section-aware chunks ready for RAG
 *
 * Heading detection uses positive signals (numbered outlines,
 * ALL-CAPS short lines, Title-Case short lines, Markdown-style #)
 * combined with length / punctuation filters.
 *
 * Tables are detected by a column-alignment heuristic (≥ 2 runs of
 * consecutive whitespace on ≥ 3 consecutive lines).
 *
 * The goal is NOT to render a PDF — it is to give RAG + citation
 * grounding a stable structural skeleton so chunks carry heading
 * context when scored.
 */

const HEADING_MAX_LEN = 140;
const HEADING_MIN_LEN = 2;
const MIN_TABLE_ROWS = 3;
const MIN_TABLE_COLS = 2;

const NUMBERED_HEADING = /^\s*(\d+(?:\.\d+){0,5})\s+\S/;
const MD_HEADING = /^\s*(#{1,6})\s+\S/;
const ROMAN_HEADING = /^\s*([IVXLCDM]{1,6})\.\s+\S/;

const FIGURE_CAPTION = /^\s*(figure|fig\.?|table|chart|diagram|image|exhibit)\s*(\d+[a-z]?|[IVXLC]+)\s*[:.\-—]/i;
const BULLET = /^\s*[-•*·▪►]\s+/;

/**
 * @param {string|Array<{page:number,text:string}>} input
 * @param {object} [opts]
 * @param {boolean} [opts.keepBullets=true]
 * @returns {{
 *   sections: Array, tables: Array, figures: Array,
 *   structured_chunks: Array, stats: object
 * }}
 */
function analyzeDocument(input, opts = {}) {
  const pages = normalizePages(input).filter(p => p.text.trim().length > 0);
  if (pages.length === 0) {
    return { sections: [], tables: [], figures: [], structured_chunks: [], stats: { pages: 0 } };
  }

  const flatLines = [];
  for (const p of pages) {
    const lines = p.text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      flatLines.push({ page: p.page, line_in_page: i, text: lines[i] });
    }
  }

  const headings = detectHeadings(flatLines);
  const tables = detectTables(flatLines);
  const figures = detectFigures(flatLines);
  const sections = buildSections(flatLines, headings);
  const structured_chunks = buildChunks(sections, { keepBullets: opts.keepBullets !== false });

  return {
    sections,
    tables,
    figures,
    structured_chunks,
    stats: {
      pages: pages.length,
      lines: flatLines.length,
      sections: sections.length,
      tables: tables.length,
      figures: figures.length,
      chunks: structured_chunks.length,
    },
  };
}

function normalizePages(input) {
  if (typeof input === "string") {
    return [{ page: 1, text: input }];
  }
  if (!Array.isArray(input)) return [];
  return input
    .filter(p => p && typeof p.text === "string")
    .map((p, i) => ({ page: Number.isFinite(p.page) ? p.page : i + 1, text: p.text }));
}

/**
 * Heading detection. Returns array of { index, page, text, level, kind }
 * where index is the position in flatLines. Level is 1 (top) to 6.
 */
function detectHeadings(flatLines) {
  const out = [];
  for (let i = 0; i < flatLines.length; i++) {
    const raw = flatLines[i].text;
    const line = raw.trim();
    if (line.length < HEADING_MIN_LEN || line.length > HEADING_MAX_LEN) continue;
    if (BULLET.test(raw)) continue;
    if (/[.!?]$/.test(line) && line.length > 80) continue;

    const md = MD_HEADING.exec(line);
    if (md) {
      out.push({
        index: i,
        page: flatLines[i].page,
        text: line.replace(/^#{1,6}\s+/, ""),
        level: md[1].length,
        kind: "md",
      });
      continue;
    }

    const numbered = NUMBERED_HEADING.exec(line);
    if (numbered) {
      const depth = numbered[1].split(".").length;
      out.push({
        index: i,
        page: flatLines[i].page,
        text: line,
        level: Math.min(depth, 6),
        kind: "numbered",
      });
      continue;
    }

    if (ROMAN_HEADING.test(line) && line.length <= 100) {
      out.push({ index: i, page: flatLines[i].page, text: line, level: 2, kind: "roman" });
      continue;
    }

    if (isAllCapsHeading(line)) {
      out.push({ index: i, page: flatLines[i].page, text: line, level: 1, kind: "allcaps" });
      continue;
    }

    if (isTitleCaseHeading(line, raw, flatLines, i)) {
      out.push({ index: i, page: flatLines[i].page, text: line, level: 2, kind: "titlecase" });
    }
  }
  return out;
}

function isAllCapsHeading(line) {
  if (line.length > 90) return false;
  const letters = line.replace(/[^A-Za-zÀ-ÿ]/g, "");
  if (letters.length < 3) return false;
  const upper = letters.replace(/[^A-ZÀ-Þ]/g, "");
  if (upper.length / letters.length < 0.85) return false;
  return !/[.]\s/.test(line);
}

function isTitleCaseHeading(line, raw, flatLines, i) {
  if (line.length > 100) return false;
  if (/[.!?]$/.test(line)) return false;
  const words = line.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 12) return false;
  const capitalized = words.filter(w => /^[A-ZÀ-Þ]/.test(w)).length;
  if (capitalized / words.length < 0.6) return false;
  const prev = flatLines[i - 1]?.text?.trim() || "";
  const next = flatLines[i + 1]?.text?.trim() || "";
  if (prev !== "" && next !== "") return false;
  return true;
}

/**
 * Table detection via column-alignment heuristic.
 * A run of ≥ MIN_TABLE_ROWS consecutive lines, each with ≥ MIN_TABLE_COLS
 * "gaps" (≥ 2 spaces) at roughly aligned columns → table.
 */
function detectTables(flatLines) {
  const tables = [];
  let i = 0;
  while (i < flatLines.length) {
    const run = collectAlignedRun(flatLines, i);
    if (run.length >= MIN_TABLE_ROWS) {
      const rows = run.map(ix => splitByGaps(flatLines[ix].text));
      const cols = Math.max(...rows.map(r => r.length));
      if (cols >= MIN_TABLE_COLS) {
        tables.push({
          page: flatLines[run[0]].page,
          rows,
          start_line: run[0],
          end_line: run[run.length - 1],
          confidence: scoreTable(rows),
        });
        i = run[run.length - 1] + 1;
        continue;
      }
    }
    i += 1;
  }
  return tables;
}

function collectAlignedRun(flatLines, start) {
  const run = [];
  for (let i = start; i < flatLines.length; i++) {
    const raw = flatLines[i].text;
    if (!hasGapColumns(raw)) break;
    run.push(i);
  }
  return run;
}

function hasGapColumns(raw) {
  if (!raw || raw.trim().length === 0) return false;
  const matches = raw.match(/\S\s{2,}\S/g);
  return Boolean(matches) && matches.length >= 1;
}

function splitByGaps(raw) {
  return raw.split(/\s{2,}/).map(c => c.trim()).filter(Boolean);
}

function scoreTable(rows) {
  const widths = rows.map(r => r.length);
  const mode = widths.sort()[Math.floor(widths.length / 2)];
  const consistent = widths.filter(w => Math.abs(w - mode) <= 1).length;
  return Math.round((consistent / widths.length) * 100) / 100;
}

function detectFigures(flatLines) {
  const figs = [];
  for (let i = 0; i < flatLines.length; i++) {
    const line = flatLines[i].text.trim();
    if (FIGURE_CAPTION.test(line)) {
      const m = FIGURE_CAPTION.exec(line);
      figs.push({
        page: flatLines[i].page,
        caption: line,
        kind: m[1].toLowerCase().replace(/\.$/, ""),
      });
    }
  }
  return figs;
}

function buildSections(flatLines, headings) {
  if (flatLines.length === 0) return [];
  if (headings.length === 0) {
    const text = flatLines.map(l => l.text).join("\n");
    return [{
      heading_path: ["(document)"],
      level: 0,
      start_page: flatLines[0].page,
      end_page: flatLines[flatLines.length - 1].page,
      text,
      char_start: 0,
      char_end: text.length,
    }];
  }

  const sections = [];
  const stack = [];
  let cursor = 0;
  if (headings[0].index > 0) {
    const preText = flatLines.slice(0, headings[0].index).map(l => l.text).join("\n");
    if (preText.trim().length > 0) {
      sections.push({
        heading_path: ["(preamble)"],
        level: 0,
        start_page: flatLines[0].page,
        end_page: flatLines[headings[0].index - 1].page,
        text: preText,
        char_start: 0,
        char_end: preText.length,
      });
    }
    cursor = preText.length;
  }

  for (let k = 0; k < headings.length; k++) {
    const h = headings[k];
    while (stack.length > 0 && stack[stack.length - 1].level >= h.level) stack.pop();
    stack.push(h);

    const start = h.index;
    const end = k + 1 < headings.length ? headings[k + 1].index : flatLines.length;
    const linesSlice = flatLines.slice(start + 1, end);
    const body = linesSlice.map(l => l.text).join("\n");
    const headingPath = stack.map(x => x.text);

    const charStart = cursor;
    const charEnd = charStart + body.length;
    cursor = charEnd;

    sections.push({
      heading_path: headingPath,
      level: h.level,
      start_page: h.page,
      end_page: linesSlice.length > 0 ? linesSlice[linesSlice.length - 1].page : h.page,
      text: body,
      char_start: charStart,
      char_end: charEnd,
    });
  }
  return sections;
}

function buildChunks(sections, opts) {
  const chunks = [];
  for (const s of sections) {
    const paragraphs = s.text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
    for (const p of paragraphs) {
      const isBullet = BULLET.test(p.split("\n")[0]);
      if (isBullet && !opts.keepBullets) continue;
      chunks.push({
        heading_path: s.heading_path,
        level: s.level,
        page: s.start_page,
        text: p,
        is_list: isBullet,
      });
    }
  }
  return chunks;
}

module.exports = {
  analyzeDocument,
  detectHeadings,
  detectTables,
  detectFigures,
  buildSections,
  buildChunks,
};
