const mammoth = require('mammoth');
const XLSX = require('xlsx');
const pdf = require('pdf-parse');
const { createWorker } = require('tesseract.js');
const sharp = require('sharp');
const fs = require('fs').promises;
const path = require('path');

class FileProcessor {
  async processFile(file) {
    try {
      const { mimetype, path: filePath, originalname } = file;
      let extractedText = '';

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
        
        default:
          extractedText = `File "${originalname}" uploaded successfully. Content type: ${mimetype}`;
      }

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
      const data = await pdf(dataBuffer);
      return data.text;
    } catch (error) {
      throw new Error(`PDF processing failed: ${error.message}`);
    }
  }

  async processWord(filePath) {
    try {
      const result = await mammoth.extractRawText({ path: filePath });
      return result.value;
    } catch (error) {
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
      return await fs.readFile(filePath, 'utf8');
    } catch (error) {
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