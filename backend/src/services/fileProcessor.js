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
    try {
      const dataBuffer = await fs.readFile(filePath);
      let data = await pdf(dataBuffer);
      console.log(`PDF file processed: ${filePath}, length: ${data.text.length}`);

      // If text is minimal, assume it's a scanned PDF and try OCR
      if (data.text.trim().length < 100) {
        console.log(`Minimal text extracted from ${filePath}. Attempting OCR...`);
        let ocrText = '';
        const document = await pdfToImage(dataBuffer, { scale: 2 });

        for await (const page of document) {
          const optimizedImage = await sharp(page)
            .greyscale()
            .normalize()
            .png()
            .toBuffer();

          const worker = await createWorker('eng');
          const { data: { text } } = await worker.recognize(optimizedImage);
          await worker.terminate();
          ocrText += text + '\n';
        }

        console.log(`OCR complete for ${filePath}. Extracted ${ocrText.length} characters.`);
        return ocrText;
      }

      return data.text;
    } catch (error) {
      console.error(`PDF processing error for ${filePath}:`, error);
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
      let text = '';

      workbook.SheetNames.forEach(sheetName => {
        const worksheet = workbook.Sheets[sheetName];
        const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

        text += `Sheet: ${sheetName}\n`;
        jsonData.forEach(row => {
          if (row.length > 0) {
            text += row.join('\t') + '\n';
          }
        });
        text += '\n';
      });

      return text;
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
