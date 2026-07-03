const mammoth = require('mammoth');
const pdf = require('pdf-parse');
const MEMORY_SAFE_MAX_BYTES = Number.parseInt(process.env.SIRAGPT_MEMORY_SAFE_MAX_BYTES || String(150 * 1024 * 1024), 10); // 150 MB
const sharp = require('sharp');
const fs = require('fs').promises;
const path = require('path');
const ocrEngine = require('./ocr-engine');
const mixedPdf = require('./document/mixed-pdf');
const officeImages = require('./office-image-extractor');
const { readXlsxFile, selectWorkbookWorksheets, worksheetRows, evaluateFormulas } = require('./xlsx-safe-workbook');
const rtfParser = require('./rtf-parser');
const odfParser = require('./opendocument-parser');
const epubParser = require('./epub-parser');
const latexParser = require('./latex-parser');
const audioTranscriber = require('./audio-transcriber');
const zipParser = require('./zip-parser');
const { detectProtectedFile, detectCorruptFile } = require('./protected-file-detector');
const { isLegacyFormat, extractLegacyText } = require('./legacy-format-converter');
const { readTextFile } = require('./text-encoding-detector');
const { detectDialect, parseCSV, formatCsvBlock } = require('./csv-dialect-detector');
const { extractFromFile: extractHtmlContent } = require('./html-content-extractor');

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

class FileProcessor {
  async processFile(file) {
    try {
      const { mimetype, path: filePath, originalname, size } = file;
      let effectiveMimeType = resolveProcessMimeType(file);

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

      let extractedText = '';
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

      if (EXTERNAL_PARSER_TYPES.includes(effectiveMimeType)) {
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

      // ── Legacy format detection & conversion (.doc, .xls, .ppt via LibreOffice) ──
      const fileExt = path.extname(String(originalname || '')).toLowerCase();
      if (effectiveMimeType !== '__external_done' && isLegacyFormat(fileExt)) {
        try {
          const legacyText = await extractLegacyText(filePath, fileExt);
          if (legacyText && legacyText.trim().length > 20) {
            extractedText = legacyText;
            console.log(`[fileProcessor] legacy format (${fileExt}) converted via LibreOffice: ${legacyText.length} chars`);
            effectiveMimeType = '__external_done';
          }
        } catch (err) {
          console.warn(`[fileProcessor] legacy format conversion failed (${fileExt}): ${err && err.message}`);
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
          extractedText = await this.processLegacyDoc(filePath, originalname);
          break;
        case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
          extractedText = await this.processWord(filePath);
          break;

        case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
        case 'application/vnd.ms-excel':
          extractedText = await this.processExcel(filePath);
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
          extractedText = await this.processPowerPoint(filePath);
          break;

        case 'audio/mpeg':
        case 'audio/wav':
        case 'audio/ogg':
        case 'audio/webm':
        case 'audio/mp4':
        case 'video/mp4':
        case 'video/mpeg':
        case 'video/quicktime':
        case 'video/webm':
          extractedText = await this.processAudio(filePath, effectiveMimeType, originalname);
          break;

        case 'application/zip':
        case 'application/x-zip':
        case 'application/x-zip-compressed':
          extractedText = await this.processZip(filePath);
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
    // Always try streaming first — it's faster, lower memory, and supports
    // unlimited pages. Only fall back to pdf-parse if streaming module
    // is unavailable.
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
          if (fullText.trim().length > 0) {
            // MIXED PDF: some pages have a text layer, others are scans/photos
            // with none. The old early-return silently dropped the scanned
            // pages. Detect them and OCR ONLY those pages, merging both
            // sources back in page order.
            let mergedText = fullText;
            let mixedOcr = null;
            try {
              if (mixedPdf.mixedOcrEnabled() && mixedPdf.isMixedPdf(pages)) {
                const lowTextPages = mixedPdf.findLowTextPages(pages);
                const cap = mixedPdf.mixedOcrMaxPages();
                console.log(`[fileProcessor] mixed PDF: ${lowTextPages.length}/${pages.length} page(s) without text layer — running per-page OCR (cap ${cap})`);
                const subset = await ocrEngine.extractPdfPagesSubset(filePath, lowTextPages, { maxPages: cap });
                const merged = mixedPdf.mergeMixedPdfText(pages, subset.pages);
                if (merged.ocrPagesUsed > 0) {
                  mergedText = merged.text;
                  mixedOcr = {
                    scannedPages: lowTextPages.length,
                    ocrPagesProcessed: subset.ocr?.pagesProcessed || 0,
                    ocrPagesWithText: merged.ocrPagesUsed,
                    capped: Boolean(subset.ocr?.capped),
                  };
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
    } catch (error) {
      if (error?.message !== 'skip_legacy_pdf_parse_large_pdf') {
        console.warn(`PDF text-layer fallback unavailable, continuing with OCR for ${filePath}:`, error.message || error);
      }
    }

    try {
      const result = await ocrEngine.extractFromPdfImages(filePath, {
        streaming: true,
      });
      const header = `PDF OCR document — ${result.ocr?.pages || 0} page(s) processed, ` +
        `${result.ocr?.pagesWithText || 0} page(s) with readable text, ` +
        `${String(result.text || '').length} characters` +
        (result.ocr?.partial ? ` (partial — ${result.ocr.partialReason || 'limit reached'})` : '') +
        `\n---\n`;
      const extractedText = result.text ? header + result.text : 'No text detected in image PDF';
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

  async processWord(filePath) {
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
      return this._withEmbeddedImageText(filePath, header + markdown, 'docx');
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

      // Formula evaluation summary
      const { formulaCount, formulaSummary } = evaluateFormulas(workbook);
      if (formulaCount > 0) {
        header += formulaSummary + '\n';
      }

      header += '\n';
      return this._withEmbeddedImageText(filePath, header + sheetSummaries.join('\n'), 'xlsx');
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

  async processImage(filePath, options = {}) {
    try {
      let result = await ocrEngine.extractFromImage(filePath, {
        mimeType: options.mimeType || 'image/png',
      });

      // GPT-4o-vision fallback. ON by default when an OpenAI key exists;
      // opt out via SIRAGPT_VISION_FALLBACK_ENABLED=0. Triggers ONLY when
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
  async _withEmbeddedImageText(filePath, baseText, kind) {
    try {
      const appendix = await officeImages.extractImageAppendix(filePath);
      if (appendix) {
        console.log(`[fileProcessor] ${kind}: appended OCR text from embedded images (${appendix.length} chars)`);
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
    // weak local OCR falls through to the vision model whenever an OpenAI
    // key is available. Opt out explicitly with SIRAGPT_VISION_FALLBACK_ENABLED=0.
    if (process.env.SIRAGPT_VISION_FALLBACK_ENABLED === '0') return false;
    if (!options.openai && !process.env.OPENAI_API_KEY) return false;
    const text = String(result?.text || '');
    const confidence = typeof result?.ocr?.confidence === 'number' ? result.ocr.confidence : 1;
    // NaN-only fallbacks: a configured 0 is meaningful (minChars=0 → never fall
    // back on char count; minConf=0 → never on confidence). `|| default` skipped
    // a legitimate 0.
    const rawMinChars = Number.parseInt(process.env.SIRAGPT_VISION_FALLBACK_MIN_CHARS, 10);
    const minChars = Number.isFinite(rawMinChars) ? rawMinChars : 100;
    const rawMinConf = Number.parseFloat(process.env.SIRAGPT_VISION_FALLBACK_MIN_CONFIDENCE);
    const minConf = Number.isFinite(rawMinConf) ? rawMinConf : 0.5;
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
      return this._withEmbeddedImageText(filePath, text, 'pptx');
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

async processAudio(filePath, mimeType, originalName) {
    try {
      const result = await audioTranscriber.transcribe(filePath, mimeType, originalName);
      if (result.method === 'whisper') {
        console.log(`[fileProcessor] Audio transcribed via Whisper: ${originalName}, ${result.text?.length || 0} chars`);
      }
      return result.text || '';
    } catch (error) {
      console.warn(`[fileProcessor] Audio transcription failed: ${error.message}`);
      return `Media file "${originalName}" — transcription unavailable. Type: ${mimeType}`;
    }
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
