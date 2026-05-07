const mammoth = require('mammoth');
const pdf = require('pdf-parse');
const MEMORY_SAFE_MAX_BYTES = Number.parseInt(process.env.SIRAGPT_MEMORY_SAFE_MAX_BYTES || String(150 * 1024 * 1024), 10); // 150 MB
const sharp = require('sharp');
const fs = require('fs').promises;
const ocrEngine = require('./ocr-engine');
const { readXlsxFile, worksheetRows } = require('./xlsx-safe-workbook');

class FileProcessor {
  async processFile(file) {
    try {
      const { mimetype, path: filePath, originalname, size } = file;

      // ── Memory-safe guard for large files ──
      // Files > MEMORY_SAFE_MAX_BYTES could OOM the process. For PDFs,
      // which load the entire buffer into RAM, we warn and sample.
      // For text files, they stream fine. For images, the OCR engine
      // already handles downsizing.
      const fileSize = typeof size === 'number' ? size : 0;
      const isLargeFile = fileSize > MEMORY_SAFE_MAX_BYTES;

      if (isLargeFile && (mimetype === 'application/pdf')) {
        console.warn(
          `[mem-safe] Large PDF (${(fileSize / 1024 / 1024).toFixed(1)} MB) — ` +
          `processing with memory-safe sampling. Set SIRAGPT_MEMORY_SAFE_MAX_BYTES to adjust.`
        );
        // For large PDFs, extract first/last pages and sample middle
        const sampled = await this.processPDFSampled(filePath, fileSize, { detailed: true });
        if (sampled) {
          return {
            success: true,
            extractedText: sampled.text,
            ocr: sampled.ocr,
            fileInfo: { name: originalname, type: mimetype, size: fileSize },
            memSafe: true,
            memSafeNote: `Large PDF sampled (${sampled.sampledPages} of ${sampled.totalPages} pages)`,
          };
        }
        // Fall through to normal processing if sampling fails
      }

      let extractedText = '';
      let ocr = ocrEngine.skipped('not_ocr_applicable').ocr;

      console.log(`Processing file: ${originalname}, type: ${mimetype}, path: ${filePath}`);

      switch (mimetype) {
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
        case 'text/csv':
        case 'text/tab-separated-values':
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
            const result = await this.processImage(filePath, { detailed: true, mimeType: mimetype });
            extractedText = result.extractedText;
            ocr = result.ocr;
          }
          break;

        case 'application/vnd.ms-powerpoint':
        case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
          extractedText = await this.processPowerPoint(filePath);
          break;

        default:
          console.log(`Unsupported file type: ${mimetype}`);
          extractedText = `File "${originalname}" uploaded successfully. Content type: ${mimetype}`;
      }

      console.log(`File processing complete for ${originalname}: ${String(extractedText || '').length} characters extracted`);

      return {
        success: true,
        extractedText,
        ocr,
        fileInfo: {
          name: originalname,
          type: mimetype,
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
    try {
      const dataBuffer = await fs.readFile(filePath);
      const data = await pdf(dataBuffer);

      console.log(`PDF processed: ${filePath}, extracted text length: ${data.text.length}, pages: ${data.numpages}`);

      // ✅ If real text exists (not just images), prepend a lightweight
      // header so the LLM can reason about file size without having to
      // count lines itself.
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
   * Memory-safe PDF extraction for very large files.
   * When PDFs exceed MEMORY_SAFE_MAX_BYTES this method avoids downstream
   * OOM by sampling first/middle/last sections of the extracted text.
   */
  async processPDFSampled(filePath, fileSize, options = {}) {
    try {
      const stat = await fs.stat(filePath).catch(() => null);
      if (!stat) return null;

      const dataBuffer = await fs.readFile(filePath);
      const bufMB = dataBuffer.length / (1024 * 1024);
      if (bufMB > 200) {
        console.warn('[mem-safe] PDF is ' + bufMB.toFixed(0) + ' MB in memory — may be slow.');
      }

      const data = await pdf(dataBuffer);
      const totalPages = data.numpages || 1;
      const fullText = data.text || '';

      if (fullText.trim().length > 100) {
        const textLen = fullText.length;
        let sampledText;
        if (textLen > 2_000_000) {
          // Sample: first 35%, middle 30%, last 35%, each at 300KB cap
          const a = Math.floor(textLen * 0.35);
          const b = Math.floor(textLen * 0.65);
          const segs = [
            '[BEGINNING — Page 1 to ~' + Math.ceil(totalPages * 0.35) + ']',
            fullText.slice(0, a).slice(0, 300000),
            '',
            '[MIDDLE — Page ~' + (Math.ceil(totalPages * 0.35) + 1) + ' to ~' + Math.ceil(totalPages * 0.65) + ']',
            fullText.slice(a, b).slice(0, 250000),
            '',
            '[END — Page ~' + (Math.ceil(totalPages * 0.65) + 1) + ' to ' + totalPages + ']',
            fullText.slice(b).slice(0, 300000),
          ];
          sampledText = segs.join('\n');
        } else {
          sampledText = fullText;
        }

        const note = textLen > 2_000_000 ? ' (sampled to ~' + sampledText.length + ' chars)' : '';
        const header = 'PDF document — ' + totalPages + ' page(s), ' + textLen + ' total characters' + note + '\n---\n';

        return {
          text: header + sampledText,
          ocr: { status: 'skipped', confidence: null, provider: 'pdf_text_layer', reason: 'embedded_text_layer', pages: totalPages },
          sampledPages: textLen > 2_000_000 ? 3 : totalPages,
          totalPages,
        };
      }

      console.log('[mem-safe] scanned PDF — delegating to OCR...');
      const result = await ocrEngine.extractFromPdfImages(filePath);
      return {
        text: result.text || 'No text detected in image PDF',
        ocr: result.ocr || { status: 'failed', confidence: 0, provider: null },
        sampledPages: totalPages,
        totalPages,
      };
    } catch (error) {
      console.error('[mem-safe] sampled PDF error:', error.message);
      return null;
    }
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
      workbook.worksheets.forEach(worksheet => {
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
      const header = `Excel workbook — ${sheetNames.length} sheet(s): ${sheetNames.join(', ')}\n\n`;
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
      const result = await ocrEngine.extractFromImage(filePath, {
        mimeType: options.mimeType || 'image/png',
      });
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
