const mammoth = require('mammoth');
const XLSX = require('xlsx');
const pdf = require('pdf-parse');
const officeParser = require('officeparser');

const { createWorker } = require('tesseract.js');
const sharp = require('sharp');
const fs = require('fs').promises;
const path = require('path');
const pdfToImage = async (filePath) => {
  const { pdf } = await import('pdf-to-img');
  return pdf(filePath);
};

class FileProcessor {
  async processFile(file) {
    try {
      const { mimetype, path: filePath, originalname } = file;
      let extractedText = '';

      console.log(`Processing file: ${originalname}, type: ${mimetype}, path: ${filePath}`);

      switch (mimetype) {
        case 'application/pdf':
          extractedText = await this.processPDF(filePath);
          break;

        case 'application/msword':
        case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
          extractedText = await this.processWord(filePath);
          break;

        case 'application/vnd.ms-excel':
        case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
          extractedText = await this.processExcel(filePath);
          break;

        case 'text/plain':
        case 'text/csv':
        case 'text/tab-separated-values':
          extractedText = await this.processText(filePath);
          break;

        case 'image/jpeg':
        case 'image/png':
        case 'image/gif':
        case 'image/webp':
          extractedText = await this.processImage(filePath);
          break;

        case 'application/vnd.ms-powerpoint':
        case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
          extractedText = await this.processPowerPoint(filePath);
          break;

        default:
          console.log(`Unsupported file type: ${mimetype}`);
          extractedText = `File "${originalname}" uploaded successfully. Content type: ${mimetype}`;
      }

      console.log(`File processing complete for ${originalname}: ${extractedText.length} characters extracted`);

      return {
        success: true,
        extractedText,
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
        extractedText: `Error processing file: ${error.message}`
      };
    }
  }


  async processPDF(filePath) {
    const { franc } = await import('franc');

    try {
      const dataBuffer = await fs.readFile(filePath);
      const data = await pdf(dataBuffer);

      console.log(`PDF processed: ${filePath}, extracted text length: ${data.text.length}, pages: ${data.numpages}`);

      // ✅ If real text exists (not just images), prepend a lightweight
      // header so the LLM can reason about file size without having to
      // count lines itself.
      if (data.text.trim().length > 100) {
        const header = `PDF document — ${data.numpages} page(s), ${data.text.length} characters extracted\n---\n`;
        return header + data.text;
      }

      console.log(`Detected scanned PDF → running OCR...`);

      const { pdf: pdfToImg } = await import('pdf-to-img');
      const pages = await pdfToImg(filePath, { scale: 2 }); // high-resolution conversion

      let ocrText = '';

      // 🧠 Use a single worker for speed (preload multiple languages)
      const worker = await createWorker('eng+spa'); // ✅ no logger here

      for await (const page of pages) {
        const optimized = await sharp(page)
          .greyscale()
          .normalize()
          .sharpen()
          .png()
          .toBuffer();

        const { data: { text } } = await worker.recognize(optimized);
        ocrText += text.trim() + '\n';
      }

      await worker.terminate();

      // 🧠 Optional: Auto language detection (fast)
      const langCode = franc(ocrText);
      const detectedLang = langCode === 'spa' ? 'Spanish' :
        langCode === 'eng' ? 'English' : 'Unknown';
      console.log(`Detected language: ${detectedLang}`);

      // 🔁 If OCR was done in wrong language (e.g. Spanish text with low confidence), retry once
      if (detectedLang === 'Spanish' && !ocrText.match(/[áéíóúñ]/i)) {
        console.log('Re-running OCR with Spanish focus...');
        const workerSpa = await createWorker('spa');
        let spaText = '';
        for await (const page of pages) {
          const optimized = await sharp(page)
            .greyscale()
            .normalize()
            .sharpen()
            .png()
            .toBuffer();
          const { data: { text } } = await workerSpa.recognize(optimized);
          spaText += text.trim() + '\n';
        }
        await workerSpa.terminate();
        if (spaText.trim().length > ocrText.trim().length / 2) {
          ocrText = spaText;
        }
      }

      console.log(`✅ OCR complete: ${ocrText.length} chars extracted`);
      return ocrText || 'No text detected in image PDF';
    } catch (error) {
      console.error(`❌ PDF processing error for ${filePath}:`, error);
      throw new Error(`PDF processing failed: ${error.message}`);
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
      const workbook = XLSX.readFile(filePath);
      const MAX_DATA_ROWS_PER_SHEET = 50; // per brain spec — headers + 50 rows

      const sheetSummaries = [];
      workbook.SheetNames.forEach(sheetName => {
        const worksheet = workbook.Sheets[sheetName];
        const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
        const nonEmptyRows = jsonData.filter(row => Array.isArray(row) && row.length > 0);

        if (nonEmptyRows.length === 0) {
          sheetSummaries.push(`Sheet: ${sheetName}\n(empty)\n`);
          return;
        }

        // First row is treated as header; everything after is data.
        const [headerRow, ...dataRows] = nonEmptyRows;
        const totalDataRows = dataRows.length;
        const shown = dataRows.slice(0, MAX_DATA_ROWS_PER_SHEET);
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

      const header = `Excel workbook — ${workbook.SheetNames.length} sheet(s): ${workbook.SheetNames.join(', ')}\n\n`;
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

  async processImage(filePath) {
    try {
      // Optimize image for OCR
      const optimizedPath = filePath + '_optimized.png';
      await sharp(filePath)
        .resize(2000, 2000, { fit: 'inside', withoutEnlargement: true })
        .greyscale()
        .normalize()
        .png()
        .toFile(optimizedPath);

      // Perform OCR
      const worker = await createWorker('eng');
      const { data: { text } } = await worker.recognize(optimizedPath);
      await worker.terminate();

      // Clean up optimized image
      try {
        await fs.unlink(optimizedPath);
      } catch (e) {
        // Ignore cleanup errors
      }

      return text || 'No text found in image';
    } catch (error) {
      throw new Error(`Image OCR processing failed: ${error.message}`);
    }
  }

  async processPowerPoint(filePath) {
    try {
      const text = await officeParser.parseOfficeAsync(filePath);
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
