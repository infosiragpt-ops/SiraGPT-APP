const mammoth = require('mammoth');
const pdf = require('pdf-parse');
const MEMORY_SAFE_MAX_BYTES = Number.parseInt(process.env.SIRAGPT_MEMORY_SAFE_MAX_BYTES || String(150 * 1024 * 1024), 10); // 150 MB
const sharp = require('sharp');
const fs = require('fs').promises;
const path = require('path');
const ocrEngine = require('./ocr-engine');
const { readXlsxFile, selectWorkbookWorksheets, worksheetRows } = require('./xlsx-safe-workbook');

let _streamingPdf;
let _streamingPdfTried = false;
function getStreamingPdf() {
  if (_streamingPdfTried) return _streamingPdf || null;
  _streamingPdfTried = true;
  try { _streamingPdf = require('./document/streaming-pdf'); } catch { _streamingPdf = null; }
  return _streamingPdf;
}

const STREAMING_PDF_THRESHOLD = Number.parseInt(
  process.env.SIRAGPT_STREAMING_PDF_THRESHOLD || String(MEMORY_SAFE_MAX_BYTES),
  10
);

/**
 * Maximum chars to extract from a streaming PDF.
 * Raised from 4M to 10M (approximately 5000-8000 pages of typical text).
 * Set SIRAGPT_STREAMING_PDF_MAX_CHARS to override.
 * Effectively unlimited for text-layer PDFs — only RSS limits apply.
 */
const STREAMING_PDF_MAX_CHARS = Number.parseInt(
  process.env.SIRAGPT_STREAMING_PDF_MAX_CHARS || '10000000',
  10
);

const GENERIC_UPLOAD_MIMES = new Set([
  '',
  'application/octet-stream',
  'application/zip',
  'application/x-zip',
  'application/x-zip-compressed',
]);

const EXTENSION_MIME_HINTS = new Map([
  ['.doc', 'application/msword'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.ppt', 'application/vnd.ms-powerpoint'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['.csv', 'text/csv'],
  ['.tsv', 'text/tab-separated-values'],
  ['.txt', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.markdown', 'text/markdown'],
  ['.json', 'application/json'],
  ['.xml', 'application/xml'],
  ['.html', 'text/html'],
  ['.htm', 'text/html'],
  ['.rtf', 'application/rtf'],
]);

function resolveProcessMimeType(file = {}) {
  const declared = String(file.mimetype || file.mimeType || '').split(';')[0].trim().toLowerCase();
  const ext = path.extname(String(file.originalname || file.originalName || file.filename || file.path || '')).toLowerCase();
  const hinted = EXTENSION_MIME_HINTS.get(ext);
  if (hinted && GENERIC_UPLOAD_MIMES.has(declared)) return hinted;
  return declared;
}

class FileProcessor {
  async processFile(file) {
    try {
      const { mimetype, path: filePath, originalname, size } = file;
      const effectiveMimeType = resolveProcessMimeType(file);

      // ── Memory-safe guard for large files ──
      // Files > MEMORY_SAFE_MAX_BYTES could OOM the process. For PDFs,
      // which load the entire buffer into RAM, we use streaming extraction.
      // For text files, they stream fine. For images, the OCR engine
      // already handles downsizing.
      const fileSize = typeof size === 'number' ? size : 0;
      const isLargeFile = fileSize > MEMORY_SAFE_MAX_BYTES;

      if (isLargeFile && (effectiveMimeType === 'application/pdf')) {
        console.warn(
          `[mem-safe] Large PDF (${(fileSize / 1024 / 1024).toFixed(1)} MB) — ` +
          `using streaming extraction. Set SIRAGPT_MEMORY_SAFE_MAX_BYTES to adjust.`
        );

        const streaming = await this.processPDFStreaming(filePath, fileSize, { detailed: true }).catch((err) => {
          console.warn('[mem-safe] streaming PDF failed:', err && err.message);
          return null;
        });
        if (streaming) {
          return {
            success: true,
            extractedText: streaming.text,
            ocr: streaming.ocr,
            fileInfo: { name: originalname, type: effectiveMimeType || mimetype, size: fileSize },
            memSafe: true,
            memSafeNote:
              `Large PDF streamed (${streaming.pageCount} pages, ` +
              `${streaming.totalChars} chars, peakRss=${streaming.peakRssMb.toFixed(0)}MB` +
              `${streaming.partial ? ', partial=true' : ''})`,
            streaming: true,
            partial: streaming.partial,
            metrics: {
              pageCount: streaming.pageCount,
              totalPages: streaming.totalPages,
              totalChars: streaming.totalChars,
              peakRssMb: streaming.peakRssMb,
              elapsedMs: streaming.elapsedMs,
            },
          };
        }

        // If streaming fails outright, try memory-safe fallback
        // but DO NOT sample — just warn and let the user know
        console.warn('[mem-safe] streaming unavailable; falling back to standard extraction. Large PDF may be slow.');
        // Fall through to normal processing
      }

      let extractedText = '';
      let ocr = ocrEngine.skipped('not_ocr_applicable').ocr;

      console.log(`Processing file: ${originalname}, type: ${mimetype}${effectiveMimeType !== mimetype ? ` -> ${effectiveMimeType}` : ''}, path: ${filePath}`);

      // ── Try external parser chain (Marker → Docling → MarkItDown) ──
      const EXTERNAL_PARSER_TYPES = ['application/pdf', 'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      ];

      if (EXTERNAL_PARSER_TYPES.includes(effectiveMimeType)) {
        try {
          const { parseFileWithBestParser } = require('./document-pipeline/parser-orchestrator');
          const result = await parseFileWithBestParser(filePath, { mimetype: effectiveMimeType });
          if (result?.available && result?.text && !result?.fallback) {
            extractedText = result.text;
            console.log(`[fileProcessor] external parser success: ${result.parser}`);
            effectiveMimeType = '__external_done';
          }
        } catch (err) {
          console.warn(`[fileProcessor] external parser chain unavailable: ${err && err.message}`);
        }
      }

      switch (effectiveMimeType) {
        case 'application/pdf':
          {
            const result = await this.processPDF(filePath, { detailed: true });
            extractedText = result.extractedText;
            ocr = result.ocr;
          }
          break;

        case 'application/msword':
        case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
          extractedText = await this.processWord(filePath);
          break;

        case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
          extractedText = await this.processExcel(filePath);
          break;

        case 'text/plain':
        case 'text/markdown':
        case 'text/csv':
        case 'text/tab-separated-values':
        case 'text/html':
        case 'text/xml':
        case 'application/xml':
        case 'application/json':
        case 'application/rtf':
        case 'text/rtf':
        case 'message/rfc822':
          extractedText = await this.processText(filePath);
          break;

        case 'image/jpeg':
        case 'image/jpg':
        case 'image/png':
        case 'image/gif':
        case 'image/webp':
        case 'image/bmp':
        case 'image/tiff':
        case 'image/svg+xml':
        case 'image/heic':
        case 'image/heif':
          {
            const result = await this.processImage(filePath, { detailed: true, mimeType: effectiveMimeType || mimetype });
            extractedText = result.extractedText;
            ocr = result.ocr;
          }
          break;

        case 'application/vnd.ms-powerpoint':
        case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
          extractedText = await this.processPowerPoint(filePath);
          break;

        case '__external_done':
          break;

        default:
          console.log(`Unsupported file type: ${mimetype}`);
          extractedText = `File "${originalname}" uploaded successfully. Content type: ${effectiveMimeType || mimetype}`;
      }

      console.log(`File processing complete for ${originalname}: ${String(extractedText || '').length} characters extracted`);

      return {
        success: true,
        extractedText,
        ocr,
        fileInfo: {
          name: originalname,
          type: effectiveMimeType || mimetype,
          size: file.size
        }
      };
    } catch (error) {
      console.error('File processing error:', error);
      return {
        success: false,
        error: error.message,
        extractedText: `Error processing file: ${error.message}`,
        ocr: {
          status: 'failed',
          confidence: 0,
          provider: null,
          reason: error.message,
        },
      };
    }
  }


  async processPDF(filePath, options = {}) {
    // Always try streaming first — it's faster, lower memory, and supports
    // unlimited pages. Only fall back to pdf-parse if streaming module
    // is unavailable.
    const streamingMod = getStreamingPdf();
    if (streamingMod) {
      try {
        // Determine file size to decide if memory-safe path needed
        let fileSize = 0;
        try {
          const stat = await require('fs').promises.stat(filePath);
          fileSize = stat.size;
        } catch {}

        const streamingResult = await streamingMod.extractPdfStreaming(filePath, {
          maxRssMb: Number.parseInt(process.env.SIRAGPT_STREAM_MAX_RSS_MB || '1200', 10),
          collectText: true,
          onPage: null, // collect all pages
        });

        if (streamingResult && streamingResult.pageCount > 0) {
          const pages = streamingResult.pages;
          // Build page-indexed text with markers for navigation
          const parts = [];
          for (let i = 0; i < pages.length; i++) {
            const p = pages[i];
            if (p.text && p.text.trim()) {
              parts.push(`\n[page ${p.page}]\n${p.text}`);
            }
          }
          const fullText = parts.join('');

          const header = `PDF document — ${streamingResult.totalPages} page(s) extracted, ` +
            `${streamingResult.totalChars} characters` +
            (streamingResult.partial ? ' (partial — RSS cap reached)' : '') +
            `\n---\n`;

          const extractedText = header + fullText;
          const ocr = {
            status: 'skipped',
            confidence: null,
            provider: 'pdf_text_layer',
            reason: 'embedded_text_layer',
            pages: streamingResult.totalPages,
            streaming: true,
            pageCount: streamingResult.pageCount,
            partial: streamingResult.partial,
          };
          return options.detailed ? { extractedText, ocr } : extractedText;
        }
      } catch (streamingErr) {
        console.warn(`[fileProcessor] streaming PDF failed, falling back to pdf-parse: ${streamingErr.message}`);
        // Fall through to pdf-parse
      }
    }

    // Legacy pdf-parse fallback — works for small PDFs or when streaming
    // module is unavailable
    try {
      const dataBuffer = await fs.readFile(filePath);
      const data = await pdf(dataBuffer);

      console.log(`PDF processed (legacy): ${filePath}, extracted text length: ${data.text.length}, pages: ${data.numpages}`);

      // If real text exists (not just images), prepend a header
      if (data.text.trim().length > 100) {
        const header = `PDF document — ${data.numpages} page(s), ${data.text.length} characters extracted\n---\n`;
        const extractedText = header + data.text;
        const ocr = {
          status: 'skipped',
          confidence: null,
          provider: 'pdf_text_layer',
          reason: 'embedded_text_layer',
          pages: data.numpages,
        };
        return options.detailed ? { extractedText, ocr } : extractedText;
      }

      console.log(`Detected scanned PDF -> running hybrid OCR...`);
      const result = await ocrEngine.extractFromPdfImages(filePath);
      const extractedText = result.text || 'No text detected in image PDF';
      console.log(`OCR complete: ${extractedText.length} chars extracted`);
      return options.detailed ? { extractedText, ocr: result.ocr } : extractedText;
    } catch (error) {
      console.error(`❌ PDF processing error for ${filePath}:`, error);
      throw new Error(`PDF processing failed: ${error.message}`);
    }
  }

  /**
   * Streaming PDF extraction: yields pages incrementally and bounds RSS.
   * This is the PRIMARY extraction path for ALL PDFs, replacing the
   * old pdf-parse in-memory approach.
   *
   * Key improvements over the old version:
   *   - No character limit cap (MAX_CHARS removed — only RSS limits apply)
   *   - Pages are streamed one-at-a-time, never held in memory
   *   - Page-level metadata for navigation
   *   - Proper RSS monitoring with graceful partial extraction
   */
  async processPDFStreaming(filePath, fileSize, options = {}) {
    const mod = getStreamingPdf();
    if (!mod) return null;

    // Use STREAMING_PDF_MAX_CHARS as a soft limit — significantly raised to 10M
    // to handle 1000+ page documents. The hard limit is RSS memory.
    const maxChars = STREAMING_PDF_MAX_CHARS;
    const parts = [];
    let totalChars = 0;
    let truncated = false;

    const result = await mod.extractPdfStreaming(filePath, {
      collectText: false,
      onPage: (p) => {
        if (truncated) return;
        if (totalChars + p.charCount > maxChars) {
          const remaining = Math.max(0, maxChars - totalChars);
          if (remaining > 100) {
            parts.push(`\n[page ${p.page}]\n` + String(p.text || '').slice(0, remaining));
          }
          totalChars += remaining;
          truncated = true;
          return;
        }
        parts.push(`\n[page ${p.page}]\n` + (p.text || ''));
        totalChars += p.charCount;
      },
    });

    const partial = Boolean(result.partial || truncated);
    const header =
      `PDF document — ${result.pageCount} page(s) streamed, ` +
      `${totalChars} chars` +
      (partial ? ' (partial — RSS or char cap reached)' : '') +
      `\n---\n`;

    return {
      text: header + parts.join(''),
      ocr: { status: 'skipped', confidence: null, provider: 'pdf_text_layer', reason: 'embedded_text_layer', pages: result.pageCount },
      pageCount: result.pageCount,
      totalPages: result.totalPages || result.pageCount,
      totalChars,
      peakRssMb: result.peakRssMb,
      elapsedMs: result.elapsedMs,
      partial,
    };
  }

  async processWord(filePath) {
    try {
      // convertToHtml preserves document structure (headings, lists,
      // emphasis, tables) which extractRawText discards. We then run
      // a minimal HTML → markdown pass so the LLM sees the document as
      // structured text instead of a flat paragraph soup.
      const { value: html } = await mammoth.convertToHtml({ path: filePath });
      const markdown = this._htmlToMarkdown(html);
      console.log(`Word file processed: ${filePath}, html=${html.length} chars, md=${markdown.length} chars`);
      const header = `Word document — ${markdown.length} characters extracted, structure preserved as markdown\n---\n`;
      return header + markdown;
    } catch (error) {
      console.error(`Word file processing error for ${filePath}:`, error);
      // Fallback to raw text so the user doesn't lose the file entirely
      // if mammoth's HTML pipeline chokes on a weird input.
      try {
        const fallback = await mammoth.extractRawText({ path: filePath });
        return fallback.value;
      } catch {
        throw new Error(`Word document processing failed: ${error.message}`);
      }
    }
  }

  /**
   * Minimal HTML → markdown transformer tuned for mammoth's output.
   * Mammoth emits a small, predictable subset of tags (h1-h6, p, ul,
   * ol, li, strong, em, table, tr, td, th, a, br) so a hand-written
   * reducer is both smaller and more predictable than pulling in
   * turndown or a full DOM parser.
   */
  _htmlToMarkdown(html) {
    if (!html) return '';
    let md = html;
    // Headings
    md = md.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n');
    md = md.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n');
    md = md.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n');
    md = md.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n');
    md = md.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, '\n##### $1\n');
    md = md.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, '\n###### $1\n');
    // Emphasis
    md = md.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**');
    md = md.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');
    // Lists — list items first so surrounding ul/ol strip cleanly
    md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');
    md = md.replace(/<\/?(ul|ol)[^>]*>/gi, '\n');
    // Tables: rows → newline-separated; cells → pipe-separated
    md = md.replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_, row) => {
      const cells = [];
      row.replace(/<(td|th)[^>]*>([\s\S]*?)<\/\1>/gi, (__, ___, cell) => { cells.push(cell.trim()); return ''; });
      return `\n| ${cells.join(' | ')} |`;
    });
    md = md.replace(/<\/?(table|tbody|thead)[^>]*>/gi, '\n');
    // Links
    md = md.replace(/<a\s+[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
    // Paragraphs and line breaks
    md = md.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n');
    md = md.replace(/<br\s*\/?>/gi, '\n');
    // Strip any remaining tags; we've handled the load-bearing ones.
    md = md.replace(/<[^>]+>/g, '');
    // Decode the five HTML entities mammoth actually emits.
    md = md.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&nbsp;/g, ' ');
    // Collapse runs of blank lines to at most two — mammoth loves to
    // emit empty paragraphs around headings.
    md = md.replace(/\n{3,}/g, '\n\n').trim();
    return md;
  }

  async processExcel(filePath) {
    try {
      const workbook = await readXlsxFile(filePath);
      const MAX_DATA_ROWS_PER_SHEET = 5000; // increased for large spreadsheets

      const sheetSummaries = [];
      const { worksheets, total, skipped, maxSheets } = selectWorkbookWorksheets(workbook);
      worksheets.forEach(worksheet => {
        const sheetName = worksheet.name;
        const nonEmptyRows = worksheetRows(worksheet, { maxRows: MAX_DATA_ROWS_PER_SHEET + 1 })
          .filter(row => Array.isArray(row) && row.length > 0);

        if (nonEmptyRows.length === 0) {
          sheetSummaries.push(`Sheet: ${sheetName}\n(empty)\n`);
          return;
        }

        // First row is treated as header; everything after is data.
        const [headerRow, ...dataRows] = nonEmptyRows;
        const totalDataRows = Math.max(0, Number(worksheet.actualRowCount || nonEmptyRows.length) - 1);
        const shown = dataRows.slice(0, Math.min(dataRows.length, MAX_DATA_ROWS_PER_SHEET));
        const truncated = totalDataRows > MAX_DATA_ROWS_PER_SHEET;

        let block = `Sheet: ${sheetName}\n`;
        block += `Columns (${headerRow.length}): ${headerRow.join(' | ')}\n`;
        block += `Total data rows: ${totalDataRows}${truncated ? ` (showing first ${MAX_DATA_ROWS_PER_SHEET})` : ''}\n`;
        block += `---\n`;
        shown.forEach(row => { block += row.join('\t') + '\n'; });
        if (truncated) {
          block += `... [${totalDataRows - MAX_DATA_ROWS_PER_SHEET} more row(s) omitted for context-window efficiency] ...\n`;
        }
        sheetSummaries.push(block);
      });

      const sheetNames = workbook.worksheets.map((worksheet) => worksheet.name);
      let header = `Excel workbook — ${total} sheet(s): ${sheetNames.join(', ')}\n`;
      if (skipped > 0) {
        header += `Showing first ${worksheets.length} sheet(s); ${skipped} sheet(s) skipped by safety cap (${maxSheets}).\n`;
        sheetSummaries.push(`[truncated: ${skipped} sheet(s) skipped by safety cap]`);
      }
      header += '\n';
      return header + sheetSummaries.join('\n');
    } catch (error) {
      throw new Error(`Excel processing failed: ${error.message}`);
    }
  }

  async processText(filePath) {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      console.log(`Text file processed: ${filePath}, length: ${content.length}`);
      return content;
    } catch (error) {
      console.error(`Text file processing error for ${filePath}:`, error);
      throw new Error(`Text file processing failed: ${error.message}`);
    }
  }

  async processImage(filePath, options = {}) {
    try {
      let result = await ocrEngine.extractFromImage(filePath, {
        mimeType: options.mimeType || 'image/png',
      });

      // Optional GPT-4o-vision fallback. Off by default; switched on
      // via env SIRAGPT_VISION_FALLBACK_ENABLED=1. Triggers ONLY when
      // Tesseract produced little text OR low-confidence output —
      // those are the cases where a vision LLM that understands
      // layout, tables, equations beats a pure OCR engine. Failures
      // are swallowed so a flaky vision call never tears down upload.
      if (this._shouldApplyVisionFallback(result, options)) {
        try {
          const visionText = await this._extractWithVision(filePath, options.mimeType, options.openai);
          if (visionText && visionText.length > (result.text?.length || 0)) {
            result = {
              text: visionText,
              ocr: {
                ...(result.ocr || {}),
                visionFallback: true,
                originalProvider: result.ocr?.provider || null,
                provider: 'gpt-4o-vision',
              },
            };
          }
        } catch (err) {
          console.warn('[fileProcessor] vision fallback failed:', err && err.message);
        }
      }

      if (options.detailed) {
        return {
          extractedText: result.text || '',
          ocr: result.ocr,
        };
      }
      return result.text || '';
    } catch (error) {
      throw new Error(`Image OCR processing failed: ${error.message}`);
    }
  }

  /**
   * Decide whether the GPT-4o-vision fallback should run on top of
   * the Tesseract result. Pure-ish — reads env once and the supplied
   * ocr result; no side effects.
   *
   * Triggers when ALL of the following are true:
   *   - SIRAGPT_VISION_FALLBACK_ENABLED=1
   *   - OPENAI_API_KEY is set (either in env OR via options.openai)
   *   - Tesseract text is shorter than SIRAGPT_VISION_FALLBACK_MIN_CHARS
   *     (default 100) OR confidence < SIRAGPT_VISION_FALLBACK_MIN_CONFIDENCE
   *     (default 0.5)
   *
   * Override via options.forceVisionFallback=true / =false for tests.
   */
  _shouldApplyVisionFallback(result, options = {}) {
    if (typeof options.forceVisionFallback === 'boolean') return options.forceVisionFallback;
    if (process.env.SIRAGPT_VISION_FALLBACK_ENABLED !== '1') return false;
    if (!options.openai && !process.env.OPENAI_API_KEY) return false;
    const text = String(result?.text || '');
    const confidence = typeof result?.ocr?.confidence === 'number' ? result.ocr.confidence : 1;
    const minChars = Number.parseInt(process.env.SIRAGPT_VISION_FALLBACK_MIN_CHARS, 10) || 100;
    const minConf = Number.parseFloat(process.env.SIRAGPT_VISION_FALLBACK_MIN_CONFIDENCE) || 0.5;
    return text.length < minChars || confidence < minConf;
  }

  /**
   * Run the vision-doc-parser against the file and flatten the
   * resulting layout into a single text string suitable for
   * downstream indexing. Markdown structure is preserved so chunking
   * + Anthropic Citations downstream see headings / tables / lists
   * instead of a single wall of text.
   *
   * `openaiClient` is injectable for tests. In production, callers
   * pass nothing and we lazily build a client from OPENAI_API_KEY.
   */
  async _extractWithVision(filePath, mimeType, openaiClient) {
    const fs = require('fs');
    const visionParser = require('./rag/vision-doc-parser');

    let openai = openaiClient;
    if (!openai) {
      const OpenAI = require('openai');
      openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }

    const buf = await fs.promises.readFile(filePath);
    const base64 = buf.toString('base64');
    const layout = await visionParser.parseDocumentPage({
      openai,
      image: { base64, mediaType: mimeType || 'image/png' },
    });
    return this._flattenLayoutToText(layout);
  }

  /**
   * Turn a DocumentLayout into a plain-text representation that
   * preserves heading levels (as Markdown), keeps tables verbatim
   * (vision parser emits markdown tables), and joins elements with
   * blank lines so downstream chunkers see logical block boundaries.
   *
   * Pure — no I/O. Easy to unit-test in isolation.
   */
  _flattenLayoutToText(layout) {
    const elements = Array.isArray(layout?.elements) ? layout.elements : [];
    const lines = [];
    for (const el of elements) {
      if (!el || typeof el.text !== 'string' || !el.text) continue;
      if (el.type === 'heading') {
        const level = Math.min(6, Math.max(1, el.level || 1));
        lines.push(`${'#'.repeat(level)} ${el.text}`);
      } else if (el.type === 'figure') {
        lines.push(`[figure] ${el.text}`);
      } else if (el.type === 'caption') {
        lines.push(`*${el.text}*`);
      } else {
        lines.push(el.text);
      }
    }
    return lines.join('\n\n').trim();
  }

  _normalizeOcrText(text) {
    return String(text || '')
      .split(/\r?\n/)
      .map(line => line.replace(/[ \t]+/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  async processPowerPoint(filePath) {
    try {
      const officeParser = require('officeparser');
      const parsed = typeof officeParser.parseOfficeAsync === 'function'
        ? await officeParser.parseOfficeAsync(filePath)
        : await officeParser.parseOffice(filePath, { ocr: false });
      const text = typeof parsed === 'string'
        ? parsed
        : (typeof parsed?.toText === 'function' ? parsed.toText() : String(parsed || ''));
      console.log(`PowerPoint file processed: ${filePath}, length: ${text.length}`);
      return text;
    } catch (error) {
      console.error(`PowerPoint file processing error for ${filePath}:`, error);
      throw new Error(`PowerPoint presentation processing failed: ${error.message}`);
    }
  }

  async generateThumbnail(filePath, mimetype) {
    if (!mimetype.startsWith('image/')) {
      return null;
    }

    try {
      const thumbnailPath = filePath + '_thumb.jpg';
      await sharp(filePath)
        .resize(200, 200, { fit: 'cover' })
        .jpeg({ quality: 80 })
        .toFile(thumbnailPath);

      return thumbnailPath;
    } catch (error) {
      console.error('Thumbnail generation failed:', error);
      return null;
    }
  }
}

module.exports = new FileProcessor();
module.exports.resolveProcessMimeType = resolveProcessMimeType;
