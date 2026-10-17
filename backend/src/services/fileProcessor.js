const mammoth = require('mammoth');
const pdf = require('pdf-parse');
const MEMORY_SAFE_MAX_BYTES = Number.parseInt(process.env.SIRAGPT_MEMORY_SAFE_MAX_BYTES || String(150 * 1024 * 1024), 10); // 150 MB
const sharp = require('sharp');
const fs = require('fs').promises;
const path = require('path');
const ocrEngine = require('./ocr-engine');
const ocrEnsemble = require('./ocr-ensemble');
const ocrQuality = require('./ocr-quality');
// Memo: when the vision runtime rejects our key (401/403) skip the fallback
// for a while instead of paying a doomed round-trip on every upload.
let visionAuthFailedUntil = 0;
const VISION_AUTH_MEMO_MS = 10 * 60 * 1000;
const mixedPdf = require('./document/mixed-pdf');
const officeImages = require('./office-image-extractor');
const { readXlsxFile, selectWorkbookWorksheets, worksheetRowEntries, evaluateFormulas, excelColLetter, DEFAULT_MAX_COLUMNS } = require('./xlsx-safe-workbook');
const rtfParser = require('./rtf-parser');
const odfParser = require('./opendocument-parser');
const epubParser = require('./epub-parser');
const latexParser = require('./latex-parser');
const audioTranscriber = require('./audio-transcriber');
const zipParser = require('./zip-parser');
const { detectProtectedFile, detectCorruptFile } = require('./protected-file-detector');
const { isLegacyFormat, extractLegacyText } = require('./legacy-format-converter');
const universalExtractor = require('./universal-document-extractor');
const { readTextFile } = require('./text-encoding-detector');
const { detectDialect, parseCSV, formatCsvBlock } = require('./csv-dialect-detector');
const { extractFromFile: extractHtmlContent } = require('./html-content-extractor');
const extractFastpath = require('./document-extract-fastpath');

let _streamingPdf;
let _streamingPdfTried = false;
function getStreamingPdf() {
  if (_streamingPdfTried) return _streamingPdf || null;
  _streamingPdfTried = true;
  try { _streamingPdf = require('./document/streaming-pdf'); } catch { _streamingPdf = null; }
  return _streamingPdf;
}

/**
 * pdf-parse's default page render (render_page in pdf-parse 1.1.4, so the
 * joined text stays byte-identical) that also records each page's text by
 * its index.
 */
function renderPdfParsePage(pageData, perPage) {
  return pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false })
    .then((textContent) => {
      let lastY;
      let text = '';
      for (const item of textContent.items) {
        if (lastY === item.transform[5] || !lastY) text += item.str;
        else text += `\n${item.str}`;
        lastY = item.transform[5];
      }
      if (Number.isInteger(pageData.pageIndex)) perPage[pageData.pageIndex] = text;
      return text;
    });
}

/**
 * pdf-parse plus the text of each page: { data, pages }. A blank line inside
 * a page (pdf.js turns an empty text item into one) looks exactly like a page
 * boundary in pdf-parse's joined text, so the stamp check reads the pages
 * themselves. `pages` is null unless they join into exactly pdf-parse's text
 * («\n\n» before every page, an unreadable page as «»): a stubbed or
 * different pdf-parse falls back to the joined text.
 */
async function parsePdfWithPages(dataBuffer, parse = pdf) {
  const perPage = [];
  const data = await parse(dataBuffer, { pagerender: (pageData) => renderPdfParsePage(pageData, perPage) });
  const count = Number(data && data.numpages) || 0;
  let pages = null;
  if (count > 0 && perPage.length <= count && typeof data.text === 'string') {
    const list = Array.from({ length: count }, (_, i) => (typeof perPage[i] === 'string' ? perPage[i] : ''));
    // Compared in place (no second copy of a long text).
    let pos = 0;
    const matches = list.every((page) => {
      if (!data.text.startsWith('\n\n', pos) || !data.text.startsWith(page, pos + 2)) return false;
      pos += 2 + page.length;
      return true;
    });
    if (matches && pos === data.text.length) pages = list;
  }
  return { data, pages };
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
  ['.xls', 'application/vnd.ms-excel'],
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
  ['.epub', 'application/epub+zip'],
  ['.tex', 'application/x-tex'],
  ['.latex', 'application/x-latex'],
  ['.zip', 'application/zip'],
  ['.ogg', 'audio/ogg'],
  ['.oga', 'audio/ogg'],
  ['.opus', 'audio/opus'],
  ['.m4a', 'audio/mp4'],
]);

async function assertReadableDocxZip(filePath) {
  let handle;
  try {
    handle = await fs.open(filePath, 'r');
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, 4, 0);
    if (bytesRead < 4 || header.toString('utf8', 0, 2) !== 'PK') {
      throw new Error('Word document is not a readable DOCX zip. Re-upload a valid .docx file or export legacy .doc files to .docx first.');
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function resolveProcessMimeType(file = {}) {
  const declared = String(file.mimetype || file.mimeType || '').split(';')[0].trim().toLowerCase();
  const ext = path.extname(String(file.originalname || file.originalName || file.filename || file.path || '')).toLowerCase();
  const hinted = EXTENSION_MIME_HINTS.get(ext);
  if (hinted && GENERIC_UPLOAD_MIMES.has(declared)) return hinted;
  return declared;
}

// ── "Any format" fallback ──────────────────────────────────────────────
// The upload policy accepts every file type. Types without a dedicated
// parser land in the `default` branch below: anything that is plain text
// (source code, configs, logs, data dumps, notebooks, subtitles…) is read as
// text so the model can actually work with it; true binaries are stored
// opaque and described by name/type (the placeholder sentence downstream
// services already recognise).
const GENERIC_TEXT_MAX_BYTES = Number.parseInt(
  process.env.SIRAGPT_GENERIC_TEXT_MAX_BYTES || String(25 * 1024 * 1024),
  10,
);

const TEXT_LIKE_MIME_RE = /^(?:text\/|application\/(?:x-)?(?:yaml|yml|toml|ini|sql|javascript|ecmascript|typescript|json5?|ld\+json|x-ndjson|ndjson|csv|x-sh|x-shellscript|x-python(?:-code)?|x-httpd-php|x-php|graphql|x-www-form-urlencoded|x-tex|x-latex|xml|xhtml\+xml|rss\+xml|atom\+xml|x-yaml|x-toml|x-ini|x-subrip|vnd\.api\+json|problem\+json|geo\+json|x-perl|x-ruby|x-lua|x-csh|x-tcl|x-r|x-julia|dart|x-httpd-cgi|postscript)|.*\+(?:json|xml|yaml)$)/i;

function isTextLikeMime(mime) {
  const normalized = String(mime || '').split(';')[0].trim().toLowerCase();
  return Boolean(normalized) && TEXT_LIKE_MIME_RE.test(normalized);
}

/**
 * Byte sniff: is the head of this file plain text? No NUL bytes and fewer
 * than 5 % non-whitespace control characters in the first 8 KiB. Encoding is
 * resolved later by readTextFile (UTF-8 / Latin-1 / UTF-16 detection).
 */
async function sniffTextLike(filePath) {
  let handle;
  try {
    handle = await fs.open(filePath, 'r');
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    if (bytesRead === 0) return false;
    let control = 0;
    for (let i = 0; i < bytesRead; i += 1) {
      const b = buf[i];
      if (b === 0) return false;
      if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c && b !== 0x1b) control += 1;
    }
    return control / bytesRead < 0.05;
  } catch {
    return false;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function opaqueBinaryPlaceholder(originalname, mimetype) {
  return `File "${originalname}" uploaded successfully. Content type: ${mimetype}`;
}

class FileProcessor {
  async processFile(file, options = {}) {
    const timer = extractFastpath.createStageTimer('processFile');
    try {
      const { mimetype, path: filePath, originalname, size } = file;
      let effectiveMimeType = resolveProcessMimeType(file);
      const processOpts = { ...options };

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
          `using pdftotext/streaming extraction. Set SIRAGPT_MEMORY_SAFE_MAX_BYTES to adjust.`
        );

        const streaming = await this.processPDFStreaming(filePath, fileSize, { detailed: true }).catch((err) => {
          console.warn('[mem-safe] streaming PDF failed:', err && err.message);
          return null;
        });
        if (streaming && streaming.totalChars > 0) {
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
        if (streaming && streaming.totalChars === 0) {
          console.warn('[mem-safe] large PDF has no embedded text layer; falling through to page OCR.');
        } else {
          // If streaming fails outright, try memory-safe fallback
          // but DO NOT sample — just warn and let the user know.
          console.warn('[mem-safe] streaming unavailable; falling back to standard extraction. Large PDF may be slow.');
        }
        // Fall through to normal processing
      }

      // ── Oversized non-PDF files ──
      // Documents up to 1 GB are accepted, but DOCX/XLSX/PPTX/ODF/EPUB/image
      // parsers load the whole file in memory. Above the memory-safe ceiling
      // only streaming readers run (PDF above, audio/video, archives listed by
      // external tools, text read up to its cap); everything else is stored
      // intact and described to the model by name, type and size.
      if (isLargeFile && effectiveMimeType !== 'application/pdf'
        && !audioTranscriber.isAudioMedia(effectiveMimeType, originalname)) {
        const family = universalExtractor.familyFor(originalname);
        const archive = family === '7z' || family === 'tar' || family === 'stream'
          || /\.zip$/i.test(String(originalname || ''));
        if (!archive) {
          const typeLabel = effectiveMimeType || mimetype || 'application/octet-stream';
          const textLike = isTextLikeMime(typeLabel) || await sniffTextLike(filePath);
          const largeText = textLike
            ? await this.processGenericText(filePath, originalname, typeLabel, fileSize)
            : opaqueBinaryPlaceholder(originalname, typeLabel);
          return {
            success: true,
            extractedText: largeText,
            ocr: ocrEngine.skipped('large_file').ocr,
            memSafe: true,
            memSafeNote: `Large file (${(fileSize / 1024 / 1024).toFixed(0)} MB) stored intact; in-memory parsers skipped.`,
            fileInfo: { name: originalname, type: typeLabel, size: fileSize },
          };
        }
      }

      let extractedText = '';
      let transcription = null;
      let ocr = ocrEngine.skipped('not_ocr_applicable').ocr;

      console.log(`Processing file: ${originalname}, type: ${mimetype}${effectiveMimeType !== mimetype ? ` -> ${effectiveMimeType}` : ''}, path: ${filePath}`);

      // ── Early detection: password-protected or corrupt files ──
      const protection = await detectProtectedFile(filePath, effectiveMimeType, originalname);
      if (protection.protected) {
        return {
          success: false,
          error: protection.message,
          extractedText: protection.message,
          ocr: { status: 'failed', confidence: 0, provider: null, reason: protection.type },
          fileInfo: { name: originalname, type: effectiveMimeType || mimetype, size: fileSize },
        };
      }

      const corruption = await detectCorruptFile(filePath, effectiveMimeType, originalname);
      if (corruption.corrupt) {
        console.warn(`[fileProcessor] corrupt file detected: ${originalname} — ${corruption.message}`);
        // Don't block — still attempt processing, but flag it
      }

      // ── Try external parser chain (Marker → Docling → MarkItDown) ──
      const EXTERNAL_PARSER_TYPES = ['application/pdf', 'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-excel',
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      ];

      const _EXT_COOLDOWN_MS = Number.parseInt(process.env.EXTERNAL_PARSER_COOLDOWN_MS || '60000', 10);

      if (EXTERNAL_PARSER_TYPES.includes(effectiveMimeType) && extractFastpath.shouldRunExternalParsers()) {
        const now = Date.now();
        if (!FileProcessor._externalParserLastFailed || (now - FileProcessor._externalParserLastFailed) > _EXT_COOLDOWN_MS) {
          try {
            const { parseFileWithBestParser } = require('./document-pipeline/parser-orchestrator');
            const result = await parseFileWithBestParser(filePath, { mimetype: effectiveMimeType });
            if (result?.available && result?.text && !result?.fallback) {
              extractedText = result.text;
              console.log(`[fileProcessor] external parser success: ${result.parser}`);
              effectiveMimeType = '__external_done';
            } else if (!result?.available) {
              FileProcessor._externalParserLastFailed = now;
              if (!FileProcessor._externalParserLogged) {
                FileProcessor._externalParserLogged = true;
                console.warn(`[fileProcessor] external parser chain unavailable (cooldown ${_EXT_COOLDOWN_MS}ms), using built-in parsers`);
              }
            }
          } catch (err) {
            FileProcessor._externalParserLastFailed = now;
            if (!FileProcessor._externalParserLogged) {
              FileProcessor._externalParserLogged = true;
              console.warn(`[fileProcessor] external parser chain error (cooldown ${_EXT_COOLDOWN_MS}ms), using built-in parsers: ${err && err.message}`);
            }
          }
        }
      }
      timer.mark('external_parser');

      // ── Legacy format detection & conversion (.doc, .xls, .ppt via LibreOffice) ──
      const fileExt = path.extname(String(originalname || '')).toLowerCase();
      // LEGACY_EXTENSIONS holds bare names ('doc'), so strip the dot — with it
      // this branch never ran and .doc/.xls/.ppt reached parsers that cannot
      // read OLE2 binaries.
      const bareExt = fileExt.replace(/^\./, '');
      if (effectiveMimeType !== '__external_done' && isLegacyFormat(bareExt)) {
        try {
          const legacyText = await extractLegacyText(filePath, bareExt);
          if (legacyText && legacyText.trim().length > 20) {
            extractedText = legacyText;
            console.log(`[fileProcessor] legacy format (${fileExt}) converted via LibreOffice: ${legacyText.length} chars`);
            effectiveMimeType = '__external_done';
          }
        } catch (err) {
          console.warn(`[fileProcessor] legacy format conversion failed (${fileExt}): ${err && err.message}`);
        }
      }

      // ── Long-tail formats (iWork, WordPerfect, Visio, 7z/tar/gz, .msg,
      // .eml/.mbox, MOBI…) — see universal-document-extractor. Runs only when
      // no dedicated parser already produced text.
      if (effectiveMimeType !== '__external_done'
        && !audioTranscriber.isAudioMedia(effectiveMimeType, originalname)
        && universalExtractor.handles(originalname)) {
        const universal = await universalExtractor.extract(filePath, originalname);
        if (universal.text) {
          extractedText = universal.text;
          effectiveMimeType = '__external_done';
        }
      }

      switch (audioTranscriber.isAudioMedia(effectiveMimeType, originalname) ? '__audio_media' : effectiveMimeType) {
        case 'application/pdf':
          {
            const result = await this.processPDF(filePath, { detailed: true, ...processOpts });
            extractedText = result.extractedText;
            ocr = result.ocr;
          }
          break;

        case 'application/msword':
          // Reached only when LibreOffice could not convert the .doc above;
          // keep the upload usable (stored + downloadable) instead of failing.
          extractedText = opaqueBinaryPlaceholder(originalname, effectiveMimeType);
          break;
        case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
          extractedText = await this.processWord(filePath, processOpts);
          break;

        case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
        case 'application/vnd.ms-excel':
          extractedText = await this.processExcel(filePath, processOpts);
          break;

        case 'text/plain':
        case 'text/markdown':
        case 'text/csv':
        case 'text/tab-separated-values':
        case 'text/html':
          extractedText = await this.processHtml(filePath);
          break;
        case 'text/xml':
        case 'application/xml':
        case 'application/json':
        case 'text/rtf':
        case 'message/rfc822':
          extractedText = await this.processText(filePath);
          break;

        case 'application/rtf':
          extractedText = await this.processRtf(filePath);
          break;

        case 'application/vnd.oasis.opendocument.text':
          extractedText = await this.processOdt(filePath);
          break;

        case 'application/vnd.oasis.opendocument.spreadsheet':
          extractedText = await this.processOds(filePath);
          break;

        case 'application/vnd.oasis.opendocument.presentation':
          extractedText = await this.processOdp(filePath);
          break;

        case 'application/epub+zip':
          extractedText = await this.processEpub(filePath);
          break;

        case 'application/x-tex':
        case 'application/x-latex':
          extractedText = await this.processLatex(filePath);
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
          extractedText = await this.processPowerPoint(filePath, processOpts);
          break;

        case '__audio_media':
        case 'audio/mpeg':
        case 'audio/wav':
        case 'audio/ogg':
        case 'audio/opus':
        case 'application/ogg':
        case 'audio/webm':
        case 'audio/mp4':
        case 'audio/m4a':
        case 'audio/x-m4a':
        case 'video/mp4':
        case 'video/mpeg':
        case 'video/quicktime':
        case 'video/webm':
          transcription = await this.processAudio(filePath, effectiveMimeType, originalname, { ...processOpts, detailed: true });
          extractedText = transcription.text || '';
          break;

        case 'application/zip':
        case 'application/x-zip':
        case 'application/x-zip-compressed':
          extractedText = await this.processZip(filePath);
          break;

        case '__external_done':
          break;

        default: {
          const typeLabel = effectiveMimeType || mimetype || 'application/octet-stream';
          const textLike = isTextLikeMime(typeLabel) || await sniffTextLike(filePath);
          if (textLike) {
            console.log(`Generic text-like file (${typeLabel}): ${originalname} — reading as text`);
            extractedText = await this.processGenericText(filePath, originalname, typeLabel, fileSize);
          } else {
            console.log(`Opaque binary upload (no text layer): ${originalname} (${typeLabel})`);
            extractedText = opaqueBinaryPlaceholder(originalname, typeLabel);
          }
          break;
        }
      }

      timer.mark('extract');
      const timings = timer.snapshot();
      extractFastpath.logExtractTiming({
        file: originalname,
        mime: effectiveMimeType || mimetype,
        bytes: fileSize,
        chars: String(extractedText || '').length,
        totalMs: timings.totalMs,
        stages: timings.stages,
      });
      console.log(`File processing complete for ${originalname}: ${String(extractedText || '').length} characters extracted in ${timings.totalMs}ms`);

      return {
        success: true,
        extractedText,
        ...(transcription ? { transcription } : {}),
        ocr,
        timings,
        fileInfo: {
          name: originalname,
          type: effectiveMimeType || mimetype,
          size: file.size
        }
      };
    } catch (error) {
      if (audioTranscriber.isAbortError(error, options.signal)) throw error;
      console.error('File processing error:', error);
      return {
        success: false,
        code: error.code || 'extraction_failed',
        error: error.message,
        // Keep extractedText EMPTY on failure — the human-readable reason lives
        // in `error` (surfaced downstream as extractionWarning). Putting the
        // error string here pollutes the chat (the model would "analyze" the
        // error text) and the RAG index. Empty → describeUnextractedAttachment
        // gives the model a sensible "couldn't extract text" note instead.
        extractedText: '',
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
    // pdftotext (poppler) is the fast path for text-layer PDFs. Fall
    // through to pdf.js streaming / OCR when the binary is missing or
    // the file is a scan.
    try {
      const pdftotext = await extractFastpath.tryPdftotext(filePath, options);
      if (pdftotext.used && pdftotext.pageCount > 0) {
        const plan = await this._textLayerPlan(pdftotext.pages, pdftotext.textLayer);
        if (plan.kind === 'scanned') {
          // «Has ≥ 20 characters» is not «has text»: stamps / page numbers
          // only, or a broken layer on every page → read the pages.
          console.log(`[fileProcessor] pdftotext: text layer of ${pdftotext.pageCount} page(s) needs OCR (${this._planSummary(plan)}) — full-page OCR`);
          return this._ocrScannedPdf(filePath, options, {
            textLayerText: pdftotext.text, pageCount: pdftotext.pageCount, layerPages: pdftotext.pages, plan,
          });
        }
        let mergedText = pdftotext.text;
        let mixedOcr = null;
        try {
          if (plan.kind === 'mixed' && mixedPdf.mixedOcrEnabled()) {
            const merged = await this._mixedPdfOcr(filePath, pdftotext.pages, plan, options, 'pdftotext');
            if (merged) {
              mergedText = merged.text;
              mixedOcr = merged.mixedOcr;
            }
          }
        } catch (mixedErr) {
          console.warn(`[fileProcessor] pdftotext mixed-OCR failed (keeping text layer): ${mixedErr.message}`);
        }

        const coverage = extractFastpath.coverageFromPages(pdftotext.pages);
        const header = `PDF document — ${pdftotext.pageCount} page(s) extracted, ` +
          `${pdftotext.totalChars} characters` +
          (mixedOcr ? ` (+${mixedOcr.ocrPagesWithText} scanned page(s) recovered via OCR)` : '') +
          `\n---\n`;
        const extractedText = header + mergedText;
        const ocr = {
          status: mixedOcr ? 'mixed_text_and_ocr' : 'skipped',
          confidence: null,
          provider: mixedOcr ? 'pdftotext+ocr' : 'pdftotext',
          reason: 'embedded_text_layer',
          pages: pdftotext.pageCount,
          streaming: false,
          pageCount: pdftotext.pageCount,
          coverage,
          ...(mixedOcr ? { mixedOcr } : {}),
        };
        return options.detailed ? { extractedText, ocr } : extractedText;
      }
      if (pdftotext.reason && pdftotext.reason !== 'disabled') {
        console.log(`[fileProcessor] pdftotext skipped (${pdftotext.reason}) — falling through`);
      }
    } catch (pdfTextErr) {
      console.warn(`[fileProcessor] pdftotext probe failed: ${pdfTextErr.message}`);
    }

    // pdf.js streaming — lower memory, unlimited pages. Only used when
    // pdftotext is unavailable or the PDF has no text layer.
    const streamingMod = getStreamingPdf();
    if (streamingMod) {
      try {
        // (The memory-safe decision is made earlier in processFile() from the
        // multer-provided size; no per-extraction fs.stat is needed here.)
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

          // Scanned / image-only PDF: streaming saw pages but extracted NO text
          // layer. Returning here would hand back a header-only "0 characters"
          // result and the user's scan would never be analyzed. Instead, fall
          // through to the pdf-parse + hybrid-OCR path below, which detects the
          // missing text layer and runs OCR. Only return early when we actually
          // captured text.
          const streamPlan = fullText.trim().length > 0 ? await this._textLayerPlan(pages) : null;
          if (streamPlan && streamPlan.kind === 'scanned') {
            console.log(`[fileProcessor] streaming PDF: text layer of ${streamingResult.pageCount} page(s) needs OCR (${this._planSummary(streamPlan)}) — full-page OCR`);
            return this._ocrScannedPdf(filePath, options, {
              textLayerText: fullText, pageCount: streamingResult.pageCount, layerPages: pages, plan: streamPlan,
            });
          }
          if (fullText.trim().length > 0) {
            // MIXED PDF: some pages have a text layer, others are scans/photos
            // (or carry a broken / stamp-only layer). OCR ONLY those pages and
            // merge both sources back in page order; pages nobody could read
            // are marked, never dropped.
            let mergedText = fullText;
            let mixedOcr = null;
            try {
              if (streamPlan.kind === 'mixed' && mixedPdf.mixedOcrEnabled()) {
                const merged = await this._mixedPdfOcr(filePath, pages, streamPlan, options, 'streaming');
                if (merged) {
                  mergedText = merged.text;
                  mixedOcr = merged.mixedOcr;
                }
              }
            } catch (mixedErr) {
              console.warn(`[fileProcessor] mixed-PDF OCR failed (keeping text layer only): ${mixedErr.message}`);
            }

            const header = `PDF document — ${streamingResult.totalPages} page(s) extracted, ` +
              `${streamingResult.totalChars} characters` +
              (mixedOcr ? ` (+${mixedOcr.ocrPagesWithText} scanned page(s) recovered via OCR)` : '') +
              (streamingResult.partial ? ' (partial — RSS cap reached)' : '') +
              `\n---\n`;

            const extractedText = header + mergedText;
            const ocr = {
              status: mixedOcr ? 'mixed_text_and_ocr' : 'skipped',
              confidence: null,
              provider: mixedOcr ? 'pdf_text_layer+ocr' : 'pdf_text_layer',
              reason: 'embedded_text_layer',
              pages: streamingResult.totalPages,
              streaming: true,
              pageCount: streamingResult.pageCount,
              partial: streamingResult.partial,
              ...(mixedOcr ? { mixedOcr } : {}),
            };
            return options.detailed ? { extractedText, ocr } : extractedText;
          }
          console.log(`[fileProcessor] streaming PDF found ${streamingResult.pageCount} page(s) but no text layer — falling through to OCR`);
        }
      } catch (streamingErr) {
        console.warn(`[fileProcessor] streaming PDF failed, falling back to pdf-parse: ${streamingErr.message}`);
        // Fall through to pdf-parse
      }
    }

    // Legacy pdf-parse fallback — works for small PDFs or when streaming
    // module is unavailable. For large scanned PDFs, skip it: pdf-parse reads
    // the whole file into memory and can OOM before OCR even starts.
    const stat = await fs.stat(filePath).catch(() => null);
    const skipLegacyPdfParse = stat && stat.size > STREAMING_PDF_THRESHOLD;
    if (skipLegacyPdfParse) {
      console.warn(`[fileProcessor] skipping in-memory pdf-parse for large PDF (${(stat.size / 1024 / 1024).toFixed(1)} MB); using page OCR`);
    }
    try {
      if (skipLegacyPdfParse) throw new Error('skip_legacy_pdf_parse_large_pdf');
      const dataBuffer = await fs.readFile(filePath);
      const { data, pages: parsedPages } = await parsePdfWithPages(dataBuffer);

      console.log(`PDF processed (legacy): ${filePath}, extracted text length: ${data.text.length}, pages: ${data.numpages}`);

      // If real text exists (not just images), prepend a header. Stamps or
      // page numbers repeated on every page are not real text.
      const stampOnly = mixedPdf.textLayerCheckEnabled() &&
        mixedPdf.isStampOnlyText(data.text, data.numpages, { pages: parsedPages });
      if (stampOnly) console.log(`[fileProcessor] pdf-parse: text layer is only stamps/page numbers — running OCR`);
      if (data.text.trim().length > 100 && !stampOnly) {
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
    } catch (error) {
      if (error?.message !== 'skip_legacy_pdf_parse_large_pdf') {
        console.warn(`PDF text-layer fallback unavailable, continuing with OCR for ${filePath}:`, error.message || error);
      }
    }

    return this._ocrScannedPdf(filePath, options);
  }

  /**
   * Text-layer OCR plan for a page list ({ page, text }): which pages need
   * OCR (short, garbled, stamp-only) and whether the document is really a
   * scan. SIRAGPT_PDF_TEXT_LAYER_CHECK=0 keeps the old length-only test.
   * Async: the plan yields to the event loop (a streamed 2000-page book
   * must not freeze the web process while it is scored).
   */
  async _textLayerPlan(pages, precomputed = null) {
    if (!mixedPdf.textLayerCheckEnabled()) {
      const low = mixedPdf.findLowTextPages(pages);
      return { kind: mixedPdf.isMixedPdf(pages) ? 'mixed' : 'text', ocrPages: low, reasons: {}, counts: {}, legacy: true };
    }
    if (precomputed && Array.isArray(precomputed.ocrPages)) return precomputed;
    return mixedPdf.planTextLayerOcrAsync(pages);
  }

  _planSummary(plan) {
    const c = plan.counts || {};
    return [`short=${c.short || 0}`, `garbled=${c.garbled || 0}`, `stamp_only=${c.stampOnly || 0}`].join(' ');
  }

  /**
   * OCR the planned pages of a mixed PDF (bounded by the mixed budget and
   * page cap) and merge them with the text layer. Returns { text, mixedOcr }.
   */
  async _mixedPdfOcr(filePath, pages, plan, options = {}, label = 'pdf') {
    const cap = mixedPdf.mixedOcrMaxPages();
    console.log(`[fileProcessor] ${label} mixed PDF: ${plan.ocrPages.length}/${pages.length} page(s) need OCR (${this._planSummary(plan)}) — cap ${cap}`);
    const subset = await ocrEngine.extractPdfPagesSubset(filePath, plan.ocrPages, {
      maxPages: cap,
      budgetMs: mixedPdf.mixedOcrBudgetMs(),
      signal: options.signal,
    });
    const merged = plan.legacy
      ? mixedPdf.mergeMixedPdfText(pages, subset.pages)
      : mixedPdf.mergeMixedPdfText(pages, subset.pages, undefined, {
        ocrTargets: plan.ocrPages,
        reasons: plan.reasons,
        markUnread: true,
      });
    if (plan.legacy && merged.ocrPagesUsed === 0) return null;
    return {
      text: merged.text,
      mixedOcr: {
        scannedPages: plan.ocrPages.length,
        ocrPagesProcessed: subset.ocr?.pagesProcessed || 0,
        ocrPagesWithText: merged.ocrPagesUsed,
        capped: Boolean(subset.ocr?.capped),
        budgetHit: Boolean(subset.ocr?.budgetHit),
        unreadPages: (merged.unreadPages || []).slice(0, 200),
        ...(plan.counts ? { garbledPages: plan.counts.garbled || 0, stampOnlyPages: plan.counts.stampOnly || 0 } : {}),
      },
    };
  }

  /**
   * Full-page OCR of a scanned PDF (every page through the OCR ladder with
   * per-page budgets). When OCR reads nothing but the PDF had a (stamp-only
   * or broken) text layer, that layer is returned instead of losing it; when
   * OCR stops early or leaves pages unread, the layer of every page it did
   * not read is spliced back in page order (`layerPages`: [{ page, text }],
   * `plan`: the text-layer plan — its per-page reasons and the pages whose
   * layer is only stamps, which are not spliced).
   */
  async _ocrScannedPdf(filePath, options = {}, { textLayerText = '', pageCount = 0, layerPages = null, plan = null } = {}) {
    try {
      const result = await ocrEngine.extractFromPdfImages(filePath, {
        streaming: true,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (!result.text && textLayerText && String(textLayerText).trim()) {
        const extractedText = `PDF document — ${pageCount || result.ocr?.pages || 0} page(s); OCR read no text, keeping the embedded text layer (it may be only stamps or page numbers)\n---\n${textLayerText}`;
        const ocr = { ...(result.ocr || {}), status: 'failed', provider: result.ocr?.provider || null, textLayerKept: true };
        return options.detailed ? { extractedText, ocr } : extractedText;
      }
      let text = result.text;
      let ocr = result.ocr;
      const spliced = result.text ? this._spliceUnreadLayerPages(result, layerPages, pageCount, plan) : null;
      if (spliced) {
        text = spliced.text;
        ocr = { ...(result.ocr || {}), textLayerPages: spliced.splicedPages.length, textLayerPageList: spliced.splicedPages.slice(0, 200) };
        console.log(`[fileProcessor] scanned PDF: OCR did not read ${spliced.splicedPages.length} page(s) — keeping their embedded text layer`);
      }
      const provenance = text ? this._ocrProvenanceSuffix(ocr) : '';
      const header = `PDF OCR document — ${ocr?.pages || 0} page(s) processed, ` +
        `${ocr?.pagesWithText || 0} page(s) with readable text, ` +
        `${String(text || '').length} characters` +
        (ocr?.partial ? ` (partial — ${ocr.partialReason || 'limit reached'})` : '') +
        (spliced ? ` (+${spliced.splicedPages.length} page(s) from the embedded text layer where OCR did not read)` : '') +
        provenance +
        `\n---\n`;
      const extractedText = text ? header + text : 'No text detected in image PDF';
      console.log(`OCR complete: ${extractedText.length} chars extracted`);
      return options.detailed ? { extractedText, ocr } : extractedText;
    } catch (error) {
      console.error(`❌ PDF processing error for ${filePath}:`, error);
      throw new Error(`PDF processing failed: ${error.message}`);
    }
  }

  /**
   * OCR stopped early (budget, page/char cap, cancel) or left pages unread:
   * splice the embedded text layer of every page it did not read instead of
   * replacing it with «sin OCR» markers. Null when there is nothing to
   * splice (no per-page results, no layer with content for those pages).
   */
  _spliceUnreadLayerPages(result, layerPages, pageCount = 0, plan = null) {
    const ocr = (result && result.ocr) || {};
    const unread = Array.isArray(ocr.unreadPages) ? ocr.unreadPages : [];
    if (!ocr.partial && unread.length === 0) return null;
    if (!Array.isArray(layerPages) || !Array.isArray(result.pages)) return null;
    if (!layerPages.some((p) => p && String(p.text || '').trim())) return null;
    const pageBlock = typeof ocrEngine._pdfPageBlock === 'function'
      ? (read) => ocrEngine._pdfPageBlock(read.page, read)
      : undefined;
    const spliced = mixedPdf.spliceTextLayerIntoOcr(layerPages, result.pages, {
      totalPages: ocr.totalPages || pageCount || 0,
      stopReason: ocr.partialReason,
      reasons: (plan && plan.reasons) || {},
      emptyLayerPages: plan && Array.isArray(plan.emptyLayerPages) ? plan.emptyLayerPages : undefined,
      pageBlock,
    });
    return spliced.splicedPages.length > 0 ? spliced : null;
  }

  /**
   * « · OCR: GLM-OCR (local) + Gemini · confianza media (72 %)» — the engines
   * that produced the text and how sure they are, so the chat can label the
   * text honestly. Empty when the result carries no confidence.
   */
  _ocrProvenanceSuffix(ocr = {}) {
    if (!ocr || typeof ocr !== 'object') return '';
    // Only engine results that rated themselves (confidenceLevel); legacy
    // results and stubs keep their text untouched.
    const confidence = Number(ocr.confidence);
    const level = ocr.confidenceLevel;
    if (!level || !Number.isFinite(confidence)) return '';
    const engines = Array.isArray(ocr.engines) && ocr.engines.length ? ocr.engines.join('+') : (ocr.provider || '');
    return ` · OCR: ${ocrEnsemble.describeEngines(engines)} · confianza ${level} (${Math.round(confidence)} %)`;
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
            // Count the chars we ACTUALLY appended, not `remaining`: the page
            // text may be shorter than `remaining` (when its real length differs
            // from p.charCount), and when remaining <= 100 nothing is appended at
            // all — so `totalChars += remaining` over-reported the size.
            const appended = String(p.text || '').slice(0, remaining);
            parts.push(`\n[page ${p.page}]\n` + appended);
            totalChars += appended.length;
          }
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

  async processWord(filePath, options = {}) {
    try {
      await assertReadableDocxZip(filePath);
      // convertToHtml preserves document structure (headings, lists,
      // emphasis, tables) which extractRawText discards. We then run
      // a minimal HTML → markdown pass so the LLM sees the document as
      // structured text instead of a flat paragraph soup.
      const { value: html } = await mammoth.convertToHtml({ path: filePath });
      const markdown = this._htmlToMarkdown(html);
      console.log(`Word file processed: ${filePath}, html=${html.length} chars, md=${markdown.length} chars`);
      const header = `Word document — ${markdown.length} characters extracted, structure preserved as markdown\n---\n`;
      return this._withEmbeddedImageText(filePath, header + markdown, 'docx', options);
    } catch (error) {
      // Mammoth throws verbose stack traces (jszip/openZip chain) when
      // the .docx is corrupt, truncated, or actually a different format
      // (e.g. .doc renamed). The outer caller (reprocessIfNeeded) has
      // its own try/catch, so we just log a compact warning and try
      // the raw-text fallback before giving up.
      const conciseMessage = error?.message || String(error);
      console.warn(`Word file processing failed for ${filePath}: ${conciseMessage}`);
      if (/not a readable DOCX zip/i.test(conciseMessage)) {
        throw new Error(conciseMessage);
      }
      // Fallback to raw text so the user doesn't lose the file entirely
      // if mammoth's HTML pipeline chokes on a weird input.
      try {
        const fallback = await mammoth.extractRawText({ path: filePath });
        return fallback.value;
      } catch (fallbackErr) {
        // Log the fallback's distinct failure reason (often a different jszip
        // corruption signature) before rethrowing with the original message —
        // the thrown error and control flow are unchanged.
        console.warn(`[fileProcessor] Word raw-text fallback also failed for ${filePath}:`, fallbackErr && fallbackErr.message || fallbackErr);
        throw new Error(`Word document processing failed: ${conciseMessage}`);
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
    const tables = [];
    // Mammoth puts paragraphs inside table cells. Convert those independently
    // before the document paragraph pass, otherwise every cell becomes a new
    // line and both the table parser and retrieval lose row relationships.
    // Cheerio is already part of the backend; use its DOM for merged cells.
    if (/<table\b/i.test(html)) {
      const $ = require('cheerio').load(html, null, false);
      let tokenPrefix = 'SIRA_TABLE_BLOCK_';
      while (html.includes(tokenPrefix)) tokenPrefix += '_';
      $('table').filter((_, table) => $(table).parents('table').length === 0).each((_, table) => {
        const grid = [];
        const tableRows = $(table).find('tr').filter((__, row) => $(row).closest('table')[0] === table);
        let spansTruncated = false;
        tableRows.each((rowIndex, row) => {
          grid[rowIndex] ||= [];
          let columnIndex = 0;
          $(row).children('td,th').each((__, cell) => {
            while (grid[rowIndex][columnIndex] !== undefined) columnIndex += 1;
            const value = this._htmlToMarkdown($(cell).html() || '')
              .replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n+/g, '<br>');
            // Span expansion cannot create rows that do not exist in the
            // source, and its total width stays within the extraction budget.
            if (columnIndex >= DEFAULT_MAX_COLUMNS) { spansTruncated = true; return; }
            const requestedColspan = Math.max(1, Number.parseInt($(cell).attr('colspan'), 10) || 1);
            const colspan = Math.min(DEFAULT_MAX_COLUMNS - columnIndex, requestedColspan);
            const requestedRowspan = Math.max(1, Number.parseInt($(cell).attr('rowspan'), 10) || 1);
            const rowspan = Math.min(tableRows.length - rowIndex, requestedRowspan);
            if (colspan < requestedColspan || rowspan < requestedRowspan) spansTruncated = true;
            for (let r = rowIndex; r < rowIndex + rowspan; r += 1) {
              grid[r] ||= [];
              for (let c = columnIndex; c < columnIndex + colspan; c += 1) grid[r][c] = value;
            }
            columnIndex += colspan;
          });
        });
        const width = grid.reduce((max, row) => Math.max(max, row.length), 0);
        const rows = grid.map((row) => `| ${Array.from({ length: width }, (__, i) => row[i] || '').join(' | ')} |`);
        if (rows.length) rows.splice(1, 0, `| ${Array(width).fill('---').join(' | ')} |`);
        if (spansTruncated) rows.push('\n[truncated: table spans exceed source rows or column safety cap]');
        const token = `${tokenPrefix}${tables.length}_END`;
        tables.push({ token, markdown: rows.join('\n') });
        $(table).replaceWith(`\n\n${token}\n\n`);
      });
      md = $.root().html();
    }
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
    // Links. Internal Word anchors (_Toc...) are mostly table-of-contents
    // plumbing; keep their label but avoid leaking raw markdown links into
    // later document analysis.
    md = md.replace(/<a\s+[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi, (_, __quote, href, label) => {
      const target = String(href || '').trim();
      const text = String(label || '').trim();
      return target.startsWith('#') ? text : `[${text}](${target})`;
    });
    // Paragraphs and line breaks
    md = md.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n');
    md = md.replace(/<br\s*\/?>/gi, '\n');
    // Strip any remaining tags; we've handled the load-bearing ones.
    md = md.replace(/<[^>]+>/g, '');
    // Decode the HTML entities mammoth actually emits. `&amp;` MUST be decoded
    // LAST — decoding it first turns an escaped `&amp;lt;` (literal "&lt;") into
    // `&lt;` and then into `<`, double-decoding the markup.
    md = md.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
    // Collapse runs of blank lines to at most two — mammoth loves to
    // emit empty paragraphs around headings.
    md = md.replace(/\n{3,}/g, '\n\n').trim();
    for (const table of tables) md = md.replace(table.token, table.markdown);
    return md;
  }

  async processExcel(filePath, options = {}) {
    try {
      const workbook = await readXlsxFile(filePath);
      const MAX_DATA_ROWS_PER_SHEET = 5000; // increased for large spreadsheets

      const sheetSummaries = [];
      const { worksheets, total, skipped, maxSheets } = selectWorkbookWorksheets(workbook);
      worksheets.forEach(worksheet => {
        const sheetName = worksheet.name;
        const { rows: nonEmptyRows, totalRows, omittedColumns } = worksheetRowEntries(worksheet, { maxRows: MAX_DATA_ROWS_PER_SHEET + 1 });

        if (nonEmptyRows.length === 0) {
          sheetSummaries.push(`Sheet: ${sheetName}\n(empty)\n`);
          return;
        }

        // First row is treated as header; everything after is data.
        const [headerEntry, ...dataRows] = nonEmptyRows;
        const width = Math.min(DEFAULT_MAX_COLUMNS, Math.max(...nonEmptyRows.map(row => row.values.length)));
        const escapeCell = value => String(value ?? '').replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\r?\n/g, '\\n').replace(/\r/g, '\\n');
        const headerRow = Array.from({ length: width }, (_, i) => escapeCell(headerEntry.values[i] || `Columna ${excelColLetter(i + 1)}`).replace(/\|/g, '\\|'));
        const totalDataRows = Math.max(0, totalRows - 1);
        const shown = dataRows.slice(0, Math.min(dataRows.length, MAX_DATA_ROWS_PER_SHEET));
        const truncated = totalDataRows > MAX_DATA_ROWS_PER_SHEET;

        let block = `Sheet: ${sheetName}\n`;
        block += `Columns (${headerRow.length}): ${headerRow.join(' | ')}\n`;
        block += `Header row: ${headerEntry.rowNumber}. Column range: A:${excelColLetter(width)}. Cell escapes: \\t = tab, \\n = line break.\n`;
        block += `Row coordinates: ${shown.map(row => row.rowNumber).join(',')}\n`;
        block += `Total data rows: ${totalDataRows}${truncated ? ` (showing first ${MAX_DATA_ROWS_PER_SHEET})` : ''}\n`;
        block += `---\n`;
        shown.forEach(row => { block += row.values.map(escapeCell).join('\t') + '\n'; });
        if (truncated) {
          block += `... [truncated: ${totalDataRows - shown.length} more populated row(s) omitted by safety cap (${MAX_DATA_ROWS_PER_SHEET})] ...\n`;
        }
        if (omittedColumns) block += `... [truncated: columns after ${excelColLetter(DEFAULT_MAX_COLUMNS)} omitted by safety cap (${DEFAULT_MAX_COLUMNS})] ...\n`;
        sheetSummaries.push(block);
      });

      const sheetNames = workbook.worksheets.map((worksheet) => worksheet.name);
      let header = `Excel workbook — ${total} sheet(s): ${sheetNames.join(', ')}\n`;
      if (skipped > 0) {
        header += `Showing first ${worksheets.length} sheet(s); ${skipped} sheet(s) skipped by safety cap (${maxSheets}).\n`;
        sheetSummaries.push(`[truncated: ${skipped} sheet(s) skipped by safety cap]`);
      }

      // Formula evaluation summary
      const { formulaCount, formulaSummary } = evaluateFormulas(workbook);
      if (formulaCount > 0) {
        header += formulaSummary + '\n';
      }

      header += '\n';
      return this._withEmbeddedImageText(filePath, header + sheetSummaries.join('\n'), 'xlsx', options);
    } catch (error) {
      throw new Error(`Excel processing failed: ${error.message}`);
    }
  }

  async processHtml(filePath) {
    try {
      const result = await extractHtmlContent(filePath);
      const header = result.title
        ? `HTML document — "${result.title}" — ${result.wordCount} words, ${result.charCount} chars\n---\n`
        : `HTML document — ${result.wordCount} words, ${result.charCount} chars\n---\n`;
      console.log(`HTML processed: ${filePath}, title="${result.title}", chars=${result.charCount}, words=${result.wordCount}`);
      return header + result.text;
    } catch (error) {
      console.warn(`HTML content extraction failed, falling back to raw: ${error.message}`);
      try {
        const { readTextFile } = require('./text-encoding-detector');
        const { text } = await readTextFile(filePath);
        return text;
      } catch {
        const content = await fs.readFile(filePath, 'utf8');
        return content;
      }
    }
  }

  async processText(filePath, options = {}) {
    try {
      // Use encoding detection for better handling of non-UTF8 text files
      const { text, encoding, confidence } = await readTextFile(filePath);
      const ext = path.extname(String(filePath || '')).toLowerCase();
      const isCSV = ext === '.csv' || ext === '.tsv';

      if (isCSV && text && text.length > 10) {
        try {
          const dialect = await detectDialect(filePath);
          const parsed = await parseCSV(filePath, { maxRows: 5000 });
          const formatted = formatCsvBlock(parsed);
          if (formatted && formatted.length > 20) {
            console.log(`CSV file processed with dialect detection: ${filePath}, encoding=${encoding}, delimiter=${dialect.delimiterName}, rows=${parsed.rows.length}`);
            return formatted;
          }
        } catch (csvErr) {
          console.warn(`[fileProcessor] CSV dialect detection failed, using raw: ${csvErr && csvErr.message}`);
        }
      }

      if (encoding !== 'utf8' && confidence > 0.6) {
        console.log(`Text file processed with encoding detection: ${filePath}, encoding=${encoding}, confidence=${confidence.toFixed(2)}`);
      }
      console.log(`Text file processed: ${filePath}, length: ${text.length}`);
      return text;
    } catch (error) {
      // Fallback to raw utf8 read if encoding detection fails
      try {
        const content = await fs.readFile(filePath, 'utf8');
        console.log(`Text file processed (fallback utf8): ${filePath}, length: ${content.length}`);
        return content;
      } catch (fallbackError) {
        console.error(`Text file processing error for ${filePath}:`, error);
        throw new Error(`Text file processing failed: ${error.message}`);
      }
    }
  }

  /**
   * Any text-like file without a dedicated parser (source code, configs,
   * logs, data dumps, subtitles, notebooks…). Reads through the encoding
   * detector, caps very large files at SIRAGPT_GENERIC_TEXT_MAX_BYTES and
   * prefixes a one-line header so the model knows what it is looking at.
   */
  async processGenericText(filePath, originalname, mimetype, fileSize = 0) {
    const ext = path.extname(String(originalname || filePath || '')).replace(/^\./, '').toLowerCase();
    const kind = ext ? `.${ext}` : (mimetype || 'text');
    const cap = Number.isFinite(GENERIC_TEXT_MAX_BYTES) && GENERIC_TEXT_MAX_BYTES > 0 ? GENERIC_TEXT_MAX_BYTES : Infinity;
    let text = '';
    let truncated = false;
    if (Number(fileSize || 0) > cap) {
      let handle;
      try {
        handle = await fs.open(filePath, 'r');
        const buf = Buffer.alloc(cap);
        const { bytesRead } = await handle.read(buf, 0, cap, 0);
        text = buf.subarray(0, bytesRead).toString('utf8');
        truncated = true;
      } finally {
        if (handle) await handle.close().catch(() => {});
      }
    } else {
      try {
        ({ text } = await readTextFile(filePath));
      } catch {
        text = await fs.readFile(filePath, 'utf8');
      }
    }
    const lines = text ? text.split(/\r?\n/).length : 0;
    const header = `Text file (${kind}) — ${lines} lines, ${text.length} chars${truncated ? ` (truncated at ${Math.round(cap / (1024 * 1024))} MB)` : ''}\n---\n`;
    console.log(`Generic text processed: ${filePath}, kind=${kind}, chars=${text.length}${truncated ? ', truncated' : ''}`);
    return header + text;
  }

  async processImage(filePath, options = {}) {
    try {
      let result = await ocrEngine.extractFromImage(filePath, {
        mimeType: options.mimeType || 'image/png',
        ...(options.signal ? { signal: options.signal } : {}),
      });

      // Layout-aware vision fallback (vision-doc-parser over the vision
      // runtimes). The engine now runs its own multi-runtime ladder with
      // reconciliation, so this second pass only runs when the engine did
      // NOT attempt one (or when forced). Opt out with
      // SIRAGPT_VISION_FALLBACK_ENABLED=0. Failures are swallowed so a flaky
      // vision call never tears down the upload.
      if (this._shouldApplyVisionFallback(result, options)) {
        try {
          const vision = await this._extractWithVisionDetailed(filePath, options.mimeType, options.openai);
          if (vision && this._preferVisionText(result, vision.text)) {
            // One unverified vision read: calibrated, never a fixed «95».
            const visionConfidence = ocrEnsemble.calibrateConfidence({
              kind: 'vlm',
              garbage: ocrQuality.assessText(String(vision.text).slice(0, 50_000)).garbageLikely,
              illegibleRatio: ocrQuality.illegibleRatio(vision.text),
            });
            result = {
              text: vision.text,
              ocr: {
                ...(result.ocr || {}),
                visionFallback: true,
                originalProvider: result.ocr?.provider || null,
                // The runtime that really answered (never a fixed label).
                provider: vision.provider,
                confidence: visionConfidence,
                confidenceLevel: ocrEnsemble.confidenceLevel(visionConfidence),
              },
            };
          }
        } catch (err) {
          const status = Number(err?.status || err?.statusCode || err?.response?.status || 0);
          if (status === 401 || status === 403 || /incorrect api key|invalid api key|unauthorized/i.test(String(err?.message || ''))) {
            visionAuthFailedUntil = Date.now() + VISION_AUTH_MEMO_MS;
          }
          console.warn('[fileProcessor] vision fallback failed:', err && err.message);
        }
      }

      // Professional header when the engine classified the image (type +
      // dimensions + tiling) or rated its read: which engines produced the
      // text and how confident they are, so the chat labels OCR text
      // honestly. Absent metadata (stubs, skipped analysis) leaves the raw
      // text untouched.
      let finalText = result.text || '';
      const imageMeta = result.ocr?.image;
      const provenance = finalText ? this._ocrProvenanceSuffix(result.ocr) : '';
      if (finalText && (imageMeta?.type || provenance)) {
        const typeLabel = imageMeta?.type ? imageMeta.typeLabelEs : 'imagen';
        const dims = imageMeta?.width && imageMeta?.height ? ` (${imageMeta.width}×${imageMeta.height} px)` : '';
        const tiledNote = imageMeta?.tiledOcr ? `, OCR por teselas ×${imageMeta.tiledOcr}` : '';
        finalText = `Imagen — ${typeLabel}${dims}${tiledNote} — ${finalText.length} caracteres extraídos${provenance}\n---\n${finalText}`;
      }

      if (options.detailed) {
        return {
          extractedText: finalText,
          ocr: result.ocr,
        };
      }
      return finalText;
    } catch (error) {
      throw new Error(`Image OCR processing failed: ${error.message}`);
    }
  }

  /**
   * Should the layout-parser text replace the engine's? Never on «longer
   * wins» alone: a garbage-looking vision answer never beats a clean local
   * read; a weak or garbage local read (confidence < 60 %, or implausible
   * words) yields to a clean vision read; a strong local read only yields to
   * a clean vision read that found clearly more (≥ 1.2×).
   */
  _preferVisionText(result, visionText) {
    const vision = String(visionText || '').trim();
    if (!vision) return false;
    const local = String(result?.text || '').trim();
    if (!local) return true;
    const visionAssess = ocrQuality.assessText(vision.slice(0, 50_000));
    const localAssess = ocrQuality.assessText(local.slice(0, 50_000));
    if (visionAssess.garbageLikely && !localAssess.garbageLikely) return false;
    const raw = Number(result?.ocr?.confidence);
    const confidence01 = Number.isFinite(raw) ? (raw > 1 ? raw / 100 : raw) : 1;
    const localWeak = confidence01 < 0.6 || localAssess.garbageLikely;
    if (localWeak) return true;
    return vision.length > local.length * 1.2;
  }

  /**
   * Decide whether the GPT-4o-vision fallback should run on top of
   * the Tesseract result. Pure-ish — reads env once and the supplied
   * ocr result; no side effects.
   *
   * Triggers when ALL of the following are true:
   *   - SIRAGPT_VISION_FALLBACK_ENABLED is not '0' (default: enabled)
   *   - OPENAI_API_KEY is set (either in env OR via options.openai)
   *   - Tesseract text is shorter than SIRAGPT_VISION_FALLBACK_MIN_CHARS
   *     (default 100) OR confidence < SIRAGPT_VISION_FALLBACK_MIN_CONFIDENCE
   *     (default 0.5)
   *
   * Override via options.forceVisionFallback=true / =false for tests.
   */
  /**
   * Best-effort append of embedded-image OCR text to an Office document's
   * extraction. Never fails the base extraction: any error (corrupt media,
   * OCR crash, timeout) logs a warning and returns the text unchanged.
   * Disable globally with SIRAGPT_OFFICE_IMAGE_OCR=0.
   */
  async _withEmbeddedImageText(filePath, baseText, kind, options = {}) {
    if (options.deferOfficeImageOcr === true) return baseText;
    try {
      const allowVision = extractFastpath.shouldAllowOfficeImageVision(baseText, options);
      const appendix = await officeImages.extractImageAppendix(filePath, { allowVision });
      if (appendix) {
        console.log(`[fileProcessor] ${kind}: appended OCR text from embedded images (${appendix.length} chars, vision=${allowVision})`);
        return `${baseText}\n\n${appendix}`;
      }
    } catch (error) {
      console.warn(`[fileProcessor] embedded-image OCR failed for ${kind} (keeping text only):`, error?.message || error);
    }
    return baseText;
  }

  _shouldApplyVisionFallback(result, options = {}) {
    if (typeof options.forceVisionFallback === 'boolean') return options.forceVisionFallback;
    // Default ON (parity with how ChatGPT/Claude read attachments): any
    // weak local OCR falls through to the vision model whenever a vision
    // runtime is available. Opt out explicitly with SIRAGPT_VISION_FALLBACK_ENABLED=0.
    if (process.env.SIRAGPT_VISION_FALLBACK_ENABLED === '0') return false;
    if (visionAuthFailedUntil > Date.now()) return false;
    // The engine already ran its own vision ladder (GLM-OCR + every cloud
    // runtime, reconciled): a second pass over the same runtimes is a
    // duplicate paid call, not a second opinion.
    const ocr = result?.ocr || {};
    if (ocr.status === 'vision_fallback' || (ocr.visionLadder && ocr.visionLadder.attempted)) return false;
    // Any configured vision runtime qualifies (Gemini / Meta / xAI / OpenRouter /
    // OpenAI) — see ai/vision-runtime.js. The OpenAI key alone is no longer the gate.
    if (!options.openai && require('./ai/vision-runtime').visionRuntimeCandidates().length === 0) return false;
    const text = String(result?.text || '');
    // ocr-engine reports confidence on a 0–100 scale; older callers and tests
    // pass 0–1. Normalise before comparing with the 0–1 threshold (the
    // 0–100 value against 0.5 disabled this branch for every weak read).
    const rawConfidence = typeof ocr.confidence === 'number' ? ocr.confidence : 1;
    const confidence = rawConfidence > 1 ? rawConfidence / 100 : rawConfidence;
    // NaN-only fallbacks: a configured 0 is meaningful (minChars=0 → never fall
    // back on char count; minConf=0 → never on confidence). `|| default` skipped
    // a legitimate 0.
    const rawMinChars = Number.parseInt(process.env.SIRAGPT_VISION_FALLBACK_MIN_CHARS, 10);
    const minChars = Number.isFinite(rawMinChars) ? rawMinChars : 100;
    const rawMinConf = Number.parseFloat(process.env.SIRAGPT_VISION_FALLBACK_MIN_CONFIDENCE);
    const minConfRaw = Number.isFinite(rawMinConf) ? rawMinConf : 0.5;
    const minConf = minConfRaw > 1 ? minConfRaw / 100 : minConfRaw;
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
  /**
   * OpenAI-compatible client for ONE vision runtime. Overridable so tests can
   * exercise the ladder without the network.
   */
  _createVisionClient(config) {
    const OpenAI = require('openai');
    // Background enrichment only: bound it. The SDK default (10 min timeout,
    // 2 retries with backoff) kept a 43 KB PNG "extracting" for ~75 s when
    // the vision runtime answered 429 (prod 2026-09-26).
    const visionTimeoutMs = Number(process.env.SIRAGPT_VISION_DOC_TIMEOUT_MS);
    const options = {
      apiKey: config.apiKey,
      timeout: Number.isFinite(visionTimeoutMs) && visionTimeoutMs >= 1000 ? visionTimeoutMs : 25_000,
      maxRetries: 1,
    };
    if (config.protocol === 'anthropic') {
      return require('./ai/first-party-chat-clients').createAnthropicStreamingClient(options);
    }
    return new OpenAI({ ...options, ...(config.baseURL ? { baseURL: config.baseURL } : {}) });
  }

  /**
   * Vision runtimes to try, in order. SIRAGPT_VISION_DOC_MODEL pins a single
   * runtime; otherwise every configured runtime qualifies (Gemini → Meta →
   * xAI → OpenRouter → OpenAI), capped by SIRAGPT_VISION_DOC_LADDER_MAX
   * (default 3) so one page never waits behind five providers.
   */
  _visionRuntimeLadder() {
    const { visionRuntimeCandidates } = require('./ai/vision-runtime');
    const explicitModel = process.env.SIRAGPT_VISION_DOC_MODEL;
    if (explicitModel) {
      return [{ provider: process.env.SIRAGPT_VISION_DOC_PROVIDER || 'OpenAI', model: explicitModel }];
    }
    const candidates = visionRuntimeCandidates();
    const rawMax = Number.parseInt(process.env.SIRAGPT_VISION_DOC_LADDER_MAX, 10);
    const max = Number.isFinite(rawMax) && rawMax >= 1 ? rawMax : 3;
    return (candidates.length > 0 ? candidates : [{ provider: 'OpenAI', model: 'gpt-5.6-sol' }]).slice(0, max);
  }

  async _extractWithVision(filePath, mimeType, openaiClient) {
    const vision = await this._extractWithVisionDetailed(filePath, mimeType, openaiClient);
    return vision ? vision.text : '';
  }

  /**
   * Same as _extractWithVision, plus WHO answered:
   * { text, provider: 'vision-doc:<provider>:<model>' }.
   */
  async _extractWithVisionDetailed(filePath, mimeType, openaiClient) {
    const fs = require('fs');
    const visionParser = require('./rag/vision-doc-parser');
    const buf = await fs.promises.readFile(filePath);
    const image = { base64: buf.toString('base64'), mediaType: mimeType || 'image/png' };

    if (openaiClient) {
      const layout = await visionParser.parseDocumentPage({ openai: openaiClient, image, options: {} });
      // Injected client (tests / legacy callers): the model is unknown.
      return { text: this._flattenLayoutToText(layout), provider: 'gpt-4o-vision' };
    }

    // Ladder over the configured vision runtimes. Prod 2026-09-27: the first
    // runtime answered 429/503 for an hour and every scanned page lost its
    // vision text («vision fallback failed: … 429 status code (no body)»)
    // while the other runtimes were healthy. A key the provider rejects
    // (401/403) is memoised via provider-key-health so the next page skips it.
    const keyHealth = require('../utils/provider-key-health');
    const { visionClientConfig } = require('./ai/vision-runtime');
    const ladder = this._visionRuntimeLadder();
    let lastError = null;
    for (let i = 0; i < ladder.length; i += 1) {
      const candidate = ladder[i];
      const config = visionClientConfig(candidate.provider);
      if (!config.apiKey) continue;
      if (keyHealth.isRejected(candidate.provider, config.apiKey)) continue;
      try {
        const layout = await visionParser.parseDocumentPage({
          openai: this._createVisionClient(config),
          image,
          options: { model: candidate.model, useStrictSchema: config.strictJsonSchema },
        });
        return {
          text: this._flattenLayoutToText(layout),
          provider: `vision-doc:${String(candidate.provider).toLowerCase()}:${candidate.model}`,
        };
      } catch (err) {
        lastError = err;
        const cause = err && err.cause ? err.cause : err;
        if (keyHealth.isInvalidKeyError(cause)) keyHealth.markRejected(candidate.provider, config.apiKey, cause);
        const status = Number(cause?.status || cause?.statusCode || 0) || null;
        const more = i < ladder.length - 1 ? ' — probando el siguiente runtime' : '';
        console.warn(`[fileProcessor] vision runtime ${candidate.provider}:${candidate.model} failed${status ? ` (${status})` : ''}: ${String((err && err.message) || err).slice(0, 200)}${more}`);
      }
    }
    if (lastError) throw lastError;
    const none = new Error('no vision runtime configured');
    none.code = 'vision_runtime_unavailable';
    throw none;
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

  async processPowerPoint(filePath, options = {}) {
    try {
      const native = await extractFastpath.extractPptxSlides(filePath);
      if (native.ok && native.text && native.slideCount > 0) {
        console.log(`PowerPoint file processed (per-slide): ${filePath}, slides=${native.slideCount}, length=${native.text.length}`);
        return this._withEmbeddedImageText(filePath, native.text, 'pptx', options);
      }
      const officeParser = require('officeparser');
      const parsed = typeof officeParser.parseOfficeAsync === 'function'
        ? await officeParser.parseOfficeAsync(filePath)
        : await officeParser.parseOffice(filePath, { ocr: false });
      const text = typeof parsed === 'string'
        ? parsed
        : (typeof parsed?.toText === 'function' ? parsed.toText() : String(parsed || ''));
      console.log(`PowerPoint file processed: ${filePath}, length: ${text.length}`);
      return this._withEmbeddedImageText(filePath, text, 'pptx', options);
    } catch (error) {
      console.error(`PowerPoint file processing error for ${filePath}:`, error);
      throw new Error(`PowerPoint presentation processing failed: ${error.message}`);
    }
  }

  async processRtf(filePath) {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = rtfParser.parseRtf(raw);
      const header = `RTF document — ${parsed.length} characters extracted, formatting hints preserved\n---\n`;
      return header + parsed;
    } catch (error) {
      console.warn(`[fileProcessor] RTF parse failed, falling back to plain text: ${error.message}`);
      return this.processText(filePath);
    }
  }

  async processOdt(filePath) {
    try {
      return await odfParser.parseOdt(filePath);
    } catch (error) {
      console.warn(`[fileProcessor] ODT parse failed: ${error.message}`);
      return `OpenDocument Text — parsing unavailable (${error.message}). Consider converting to DOCX for best results.`;
    }
  }

  async processOds(filePath) {
    try {
      return await odfParser.parseOds(filePath);
    } catch (error) {
      console.warn(`[fileProcessor] ODS parse failed: ${error.message}`);
      return `OpenDocument Spreadsheet — parsing unavailable (${error.message}). Consider converting to XLSX for best results.`;
    }
  }

  async processOdp(filePath) {
    try {
      return await odfParser.parseOdp(filePath);
    } catch (error) {
      console.warn(`[fileProcessor] ODP parse failed: ${error.message}`);
      return `OpenDocument Presentation — parsing unavailable (${error.message}). Consider converting to PPTX for best results.`;
    }
  }

  async processEpub(filePath) {
    try {
      return await epubParser.parseEpub(filePath);
    } catch (error) {
      console.warn(`[fileProcessor] EPUB parse failed: ${error.message}`);
      return `EPUB document — parsing unavailable (${error.message}). Consider converting to PDF for best results.`;
    }
  }

  async processLatex(filePath) {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = latexParser.parseLatex(raw);
      const header = `LaTeX document — ${parsed.length} characters extracted, math stripped\n---\n`;
      return header + parsed;
    } catch (error) {
      console.warn(`[fileProcessor] LaTeX parse failed, falling back to plain text: ${error.message}`);
      return this.processText(filePath);
    }
  }

  async processAudio(filePath, mimeType, originalName, options = {}) {
    const result = await audioTranscriber.transcribe(filePath, mimeType, originalName, options);
    if (!audioTranscriber.SUCCESS_METHODS.has(result.method) || !String(result.transcript || '').trim()) {
      const reason = result.reasonCode || 'local_unavailable';
      const message = reason === 'no_speech' ? 'No se detectó voz en el archivo.'
        : reason === 'file_empty' ? 'El archivo está vacío.'
          : reason === 'file_unavailable' ? 'No se pudo leer el archivo de audio.'
            : reason === 'audio_decode_failed' ? 'No se pudo decodificar el audio; comprueba que el archivo no esté dañado.'
              : reason === 'low_coverage' ? 'Demasiados tramos no se pudieron transcribir esta vez. Reintentar recupera solo los tramos que faltan.'
                : 'La transcripción no está disponible temporalmente. Puedes reintentarlo.';
      throw Object.assign(new Error(message), { code: reason });
    }
    return options.detailed ? result : result.text;
  }

  async processZip(filePath) {
    try {
      const text = await zipParser.parseZip(filePath);
      const header = `ZIP Archive — contents extracted below\n---\n`;
      return header + text;
    } catch (error) {
      console.warn(`[fileProcessor] ZIP parsing failed: ${error.message}`);
      return `ZIP archive — extraction unavailable (${error.message}). Install 'unzip' for ZIP support.`;
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
module.exports.isTextLikeMime = isTextLikeMime;
module.exports.sniffTextLike = sniffTextLike;
module.exports.parsePdfWithPages = parsePdfWithPages;
