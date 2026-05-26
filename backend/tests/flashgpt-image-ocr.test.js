const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ocrEngine = require('../src/services/ocr-engine');
const flashGptImageOcr = require('../src/services/flashgpt-image-ocr');

test('buildFlashGptImageOcrContext injects local OCR text for image attachments', async () => {
  const originalExtract = ocrEngine.extractFromImage;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flashgpt-ocr-'));
  const imagePath = path.join(tmpDir, 'screen.png');
  fs.writeFileSync(imagePath, Buffer.from('fake-image'));

  const updates = [];
  const prisma = {
    file: {
      update: async (args) => {
        updates.push(args);
        return args.data;
      },
    },
  };

  ocrEngine.extractFromImage = async (filePath, options) => {
    assert.equal(filePath, imagePath);
    assert.equal(options.mode, 'local');
    assert.equal(options.allowVision, false);
    return {
      text: 'Factura 123\nTotal: 45.00 USD',
      ocr: { status: 'local_ok', provider: 'tesseract', confidence: 91 },
    };
  };

  try {
    const result = await flashGptImageOcr.buildFlashGptImageOcrContext(prisma, {
      userId: 'user_1',
      files: [{
        id: 'file_1',
        name: 'factura.png',
        mimeType: 'image/png',
        path: imagePath,
      }],
    });

    assert.equal(result.imageCount, 1);
    assert.equal(result.readableCount, 1);
    assert.match(result.block, /FLASHGPT OCR VISUAL BRIDGE/);
    assert.match(result.block, /Factura 123/);
    assert.match(result.block, /Total: 45\.00 USD/);
    assert.equal(result.files[0].extractedText, 'Factura 123\nTotal: 45.00 USD');
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0], {
      where: { id: 'file_1' },
      data: { extractedText: 'Factura 123\nTotal: 45.00 USD' },
    });
  } finally {
    ocrEngine.extractFromImage = originalExtract;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('buildFlashGptImageOcrContext reuses stored OCR text without rerunning OCR', async () => {
  const originalExtract = ocrEngine.extractFromImage;
  let calls = 0;
  ocrEngine.extractFromImage = async () => {
    calls += 1;
    return { text: 'should not be used', ocr: {} };
  };

  try {
    const result = await flashGptImageOcr.buildFlashGptImageOcrContext(null, {
      userId: 'user_1',
      files: [{
        id: 'file_2',
        name: 'captura.jpg',
        mimeType: 'image/jpeg',
        extractedText: 'Texto OCR ya guardado',
      }],
    });

    assert.equal(calls, 0);
    assert.equal(result.readableCount, 1);
    assert.match(result.block, /Texto OCR ya guardado/);
  } finally {
    ocrEngine.extractFromImage = originalExtract;
  }
});
