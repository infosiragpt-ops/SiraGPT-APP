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
      const result = await mammoth.extractRawText({ path: filePath });
      console.log(`Word file processed: ${filePath}, length: ${result.value.length}`);
      return result.value;
    } catch (error) {
      console.error(`Word file processing error for ${filePath}:`, error);
      throw new Error(`Word document processing failed: ${error.message}`);
    }
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
