const { createWorker } = require('tesseract.js');
const sharp = require('sharp');
const fs = require('fs').promises;
const OpenAI = require('openai');

const OCR_PLACEHOLDER_RE = /^(no text found in image|no text detected(?: in image pdf)?|no content available|binary file|file content could not be extracted|file ".*?" uploaded successfully|error processing file:|unsupported file type)/i;

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function normalizeOcrText(text) {
  return String(text || '')
    .replace(/\u0000/g, '')
    .split(/\r?\n/)
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function usefulCharCount(text) {
  const matches = String(text || '').match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9]/g);
  return matches ? matches.length : 0;
}

class OcrEngine {
  constructor() {
    // Configurable default language via env. Falls back to spa+eng.
    this.defaultLanguage = process.env.OCR_DEFAULT_LANGUAGE || 'spa+eng';
  }

  get config() {
    return {
      mode: String(process.env.OCR_MODE || 'hybrid').toLowerCase(),
      minConfidence: numberFromEnv('OCR_MIN_CONFIDENCE', 70),
      minUsefulChars: numberFromEnv('OCR_MIN_USEFUL_CHARS', 20),
      visionModel: process.env.OCR_VISION_MODEL || process.env.VISION_MODEL || 'gpt-4o-mini',
      visionPdfMaxPages: numberFromEnv('OCR_VISION_PDF_MAX_PAGES', 20),
      visionPdfStrategy: process.env.OCR_VISION_PDF_STRATEGY || 'first', // first | first-last-middle | first
    };
  }

  skipped(reason = 'not_ocr_applicable') {
    return {
      text: '',
      ocr: {
        status: 'skipped',
        confidence: null,
        provider: null,
        reason,
      },
    };
  }

  hasUsefulText(value, config = this.config) {
    const text = normalizeOcrText(value);
    if (!text || OCR_PLACEHOLDER_RE.test(text)) return false;
    return usefulCharCount(text) >= Math.min(3, config.minUsefulChars);
  }

  evaluateQuality({ text, confidence = 0 } = {}, config = this.config) {
    const normalized = normalizeOcrText(text);
    const lineCount = normalized
      .split(/\n+/)
      .map(line => line.trim())
      .filter(Boolean).length;
    const usefulChars = usefulCharCount(normalized);
    const numericConfidence = Number(confidence || 0);
    const placeholder = !normalized || OCR_PLACEHOLDER_RE.test(normalized);
    const enoughText = usefulChars >= config.minUsefulChars;
    const confident = numericConfidence >= config.minConfidence;
    const legibleShort = !placeholder && usefulChars >= Math.min(3, config.minUsefulChars) && confident;

    return {
      text: normalized,
      confidence: numericConfidence,
      usefulChars,
      lineCount,
      placeholder,
      enoughText,
      confident,
      legibleShort,
      accepted: !placeholder && enoughText && confident,
      usefulButWeak: !placeholder && enoughText && !confident,
      reason: placeholder ? 'empty_or_placeholder' : !enoughText ? 'too_little_text' : !confident ? 'low_confidence' : 'ok',
    };
  }

  shouldUseVisionFallback(quality, options = {}) {
    const mode = String(options.mode || this.config.mode || 'hybrid').toLowerCase();
    if (mode === 'off' || mode === 'local') return false;
    if (mode === 'vision') return true;
    return !quality?.accepted;
  }

  async extractFromImage(filePath, options = {}) {
    const config = this.config;
    const mode = String(options.mode || config.mode).toLowerCase();
    if (mode === 'off') return this.skipped('ocr_disabled');

    if (mode === 'vision') {
      return this.runVisionFallback({ filePath, mimeType: options.mimeType || 'image/png', config });
    }

    let localResult;
    try {
      localResult = await this.runLocalImageOcr(filePath, options);
    } catch (error) {
      localResult = {
        quality: this.evaluateQuality({ text: '', confidence: 0 }, config),
        error: error?.message || 'local_ocr_failed',
      };
    }
    if (localResult.quality.accepted) {
      return this.asLocalResult(localResult);
    }

    if (this.shouldUseVisionFallback(localResult.quality, { mode }) && options.allowVision !== false) {
      const visionResult = await this.runVisionFallback({
        filePath,
        mimeType: options.mimeType || 'image/png',
        config,
        localQuality: localResult.quality,
      });

      if (visionResult.ocr.status === 'vision_fallback') return visionResult;
    }

    if (localResult.quality.enoughText || localResult.quality.legibleShort) {
      const result = this.asLocalResult(localResult);
      result.ocr.warning = 'vision_fallback_unavailable_or_weaker';
      return result;
    }

    return this.asFailedResult(localResult.quality, localResult.error);
  }

  async extractFromPdfImages(filePath, options = {}) {
    const config = this.config;
    const mode = String(options.mode || config.mode).toLowerCase();
    if (mode === 'off') return this.skipped('ocr_disabled');

    const pageBuffers = await this.renderPdfPages(filePath);
    if (pageBuffers.length === 0) {
      return {
        text: '',
        ocr: {
          status: 'failed',
          confidence: 0,
          provider: 'tesseract',
          reason: 'no_pdf_pages_rendered',
        },
      };
    }

    if (mode === 'vision') {
      return this.runVisionPdfFallback(pageBuffers, { config });
    }

    let localResult;
    try {
      localResult = await this.recognizePageBuffers(pageBuffers, { language: options.language || this.defaultLanguage });
    } catch (error) {
      localResult = {
        quality: this.evaluateQuality({ text: '', confidence: 0 }, config),
        error: error?.message || 'local_pdf_ocr_failed',
      };
    }
    if (localResult.quality.accepted) {
      return {
        text: localResult.quality.text,
        ocr: {
          status: 'local_ok',
          confidence: Math.round(localResult.quality.confidence),
          provider: 'tesseract',
          usefulChars: localResult.quality.usefulChars,
          lineCount: localResult.quality.lineCount,
          pages: pageBuffers.length,
        },
      };
    }

    if (this.shouldUseVisionFallback(localResult.quality, { mode }) && options.allowVision !== false) {
      const visionResult = await this.runVisionPdfFallback(pageBuffers, { config, localQuality: localResult.quality });
      if (visionResult.ocr.status === 'vision_fallback') return visionResult;
    }

    if (localResult.quality.enoughText || localResult.quality.legibleShort) {
      return {
        text: localResult.quality.text,
        ocr: {
          status: 'local_ok',
          confidence: Math.round(localResult.quality.confidence),
          provider: 'tesseract',
          usefulChars: localResult.quality.usefulChars,
          lineCount: localResult.quality.lineCount,
          pages: pageBuffers.length,
          warning: localResult.quality.legibleShort ? 'below_min_useful_chars_but_confident' : 'vision_fallback_unavailable_or_weaker',
        },
      };
    }

    return this.asFailedResult(localResult.quality, localResult.error, { pages: pageBuffers.length });
  }

  async createImageVariants(filePath) {
    const base = sharp(filePath)
      .rotate()
      .resize(3000, 3000, { fit: 'inside', withoutEnlargement: false })
      .greyscale();

    return Promise.all([
      // 1. Normalize + sharpen (best for well-lit documents)
      base.clone().normalize().sharpen().png().toBuffer(),
      // 2. High contrast — linear stretch (best for faded text)
      base.clone().linear(1.25, -8).normalize().sharpen().png().toBuffer(),
      // 3. Hard threshold binarization (best for clean scans)
      base.clone().normalize().threshold(165).png().toBuffer(),
      // 4. Adaptive threshold via local contrast (best for uneven lighting)
      this._adaptiveThreshold(base.clone()),
      // 5. Inverted — white text on black (important for some diagrams)
      base.clone().negate({ alpha: false }).normalize().sharpen().png().toBuffer(),
    ]);
  }

  /**
   * Approximate adaptive thresholding by applying a strong blur
   * (local-mean estimate) and then subtracting it before thresholding.
   * This handles documents photographed with shadows or uneven lighting.
   */
  async _adaptiveThreshold(sharpInstance) {
    // Blur, subtract from original, then threshold
    const blurred = sharpInstance.clone().blur(20);
    // Use composite to subtract blurred from original
    const result = await sharpInstance
      .composite([{ input: await blurred.png().toBuffer(), blend: 'difference' }])
      .normalize()
      .threshold(128)
      .png()
      .toBuffer();
    return result;
  }

  async runLocalImageOcr(filePath, options = {}) {
    const variants = await this.createImageVariants(filePath);
    const worker = await createWorker(options.language || this.defaultLanguage);
    let best = this.evaluateQuality({ text: '', confidence: 0 });

    try {
      for (const variant of variants) {
        const { data: { text, confidence } } = await worker.recognize(variant);
        const quality = this.evaluateQuality({ text, confidence });
        const bestScore = best.usefulChars * 2 + best.confidence;
        const qualityScore = quality.usefulChars * 2 + quality.confidence;
        if (qualityScore > bestScore) best = quality;
      }
    } finally {
      await worker.terminate();
    }

    return { quality: best, variants: variants.length };
  }

  async recognizePageBuffers(pageBuffers, options = {}) {
    const worker = await createWorker(options.language || this.defaultLanguage);
    const pageResults = [];
    try {
      for (const pageBuffer of pageBuffers) {
        const { data: { text, confidence } } = await worker.recognize(pageBuffer);
        pageResults.push({
          text: normalizeOcrText(text),
          confidence: Number(confidence || 0),
        });
      }
    } finally {
      await worker.terminate();
    }

    const text = pageResults.map(page => page.text).filter(Boolean).join('\n\n');
    const confidence = pageResults.length
      ? pageResults.reduce((sum, page) => sum + page.confidence, 0) / pageResults.length
      : 0;

    return {
      quality: this.evaluateQuality({ text, confidence }),
      pages: pageResults,
    };
  }

  async renderPdfPages(filePath) {
    const { pdf } = await import('pdf-to-img');
    const pages = await pdf(filePath, { scale: 3 });
    const buffers = [];

    for await (const page of pages) {
      const buffer = await sharp(page)
        .rotate()
        .resize(3000, 3000, { fit: 'inside', withoutEnlargement: false })
        .greyscale()
        .normalize()
        .sharpen()
        .png()
        .toBuffer();
      buffers.push(buffer);
    }

    return buffers;
  }

  async runVisionPdfFallback(pageBuffers, { config = this.config, localQuality = null } = {}) {
    const maxPages = Math.min(pageBuffers.length, config.visionPdfMaxPages || 20, 50);
    const strategy = config.visionPdfStrategy || 'first';

    // Select pages based on strategy
    let pageIndices = [];
    if (strategy === 'first-last-middle' && pageBuffers.length > 3) {
      // First pages, middle pages, last pages
      const firstCount = Math.ceil(maxPages * 0.4);
      const lastCount = Math.ceil(maxPages * 0.3);
      const middleCount = maxPages - firstCount - lastCount;
      for (let i = 0; i < firstCount; i++) pageIndices.push(i);
      const midStart = Math.max(firstCount, Math.floor((pageBuffers.length - middleCount) / 2));
      for (let i = 0; i < middleCount; i++) pageIndices.push(midStart + i);
      for (let i = 0; i < lastCount; i++) pageIndices.push(pageBuffers.length - lastCount + i);
    } else {
      // 'first' strategy: take first N pages
      for (let i = 0; i < maxPages; i++) pageIndices.push(i);
    }

    pageIndices = [...new Set(pageIndices)].sort((a, b) => a - b).slice(0, maxPages);

    const texts = [];
    let totalConfidence = 0;
    let usedPages = 0;

    for (let idx = 0; idx < pageIndices.length; idx += 1) {
      const pageIdx = pageIndices[idx];
      const result = await this.runVisionFallback({
        buffer: pageBuffers[pageIdx],
        mimeType: 'image/png',
        config,
        localQuality,
        promptPrefix: `Pagina ${pageIdx + 1} de ${pageBuffers.length}.`,
      });

      if (result.ocr.status === 'vision_fallback' && result.text) {
        texts.push(result.text);
        totalConfidence += Number(result.ocr.confidence || 0);
        usedPages += 1;
      }
    }

    const text = normalizeOcrText(texts.join('\n\n'));
    const quality = this.evaluateQuality({
      text,
      confidence: usedPages ? totalConfidence / usedPages : 0,
    }, config);

    if (quality.enoughText || quality.legibleShort) {
      return {
        text: quality.text,
        ocr: {
          status: 'vision_fallback',
          confidence: Math.round(quality.confidence || 92),
          provider: `openai:${config.visionModel}`,
          usefulChars: quality.usefulChars,
          lineCount: quality.lineCount,
          pages: pageBuffers.length,
          pagesReadByVision: usedPages,
          localConfidence: localQuality?.confidence ?? null,
        },
      };
    }

    return this.asFailedResult(quality, 'vision_fallback_empty', { pages: pageBuffers.length });
  }

  async runVisionFallback({ filePath, buffer, mimeType = 'image/png', config = this.config, localQuality = null, promptPrefix = '' }) {
    if (!process.env.OPENAI_API_KEY) {
      return {
        text: '',
        ocr: {
          status: 'failed',
          confidence: 0,
          provider: null,
          reason: 'vision_api_unavailable',
          localConfidence: localQuality?.confidence ?? null,
        },
      };
    }

    try {
      const imageBuffer = buffer || await fs.readFile(filePath);
      const dataUrl = `data:${mimeType};base64,${imageBuffer.toString('base64')}`;
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

      const response = await openai.chat.completions.create({
        model: config.visionModel,
        temperature: 0,
        max_tokens: 4096,
        messages: [
          {
            role: 'system',
            content: 'You are a professional OCR engine. Return ONLY the visible text from the image. Preserve useful line breaks. Do NOT invent or hallucinate content. Do NOT translate — output text in the original language. If you cannot read any text, respond with exactly: OCR_EMPTY',
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `${promptPrefix} Transcribe todo el texto visible de esta imagen. Si no hay texto legible, responde exactamente: OCR_EMPTY`,
              },
              {
                type: 'image_url',
                image_url: { url: dataUrl, detail: 'high' },
              },
            ],
          },
        ],
      });

      const text = normalizeOcrText(response.choices?.[0]?.message?.content || '');
      const quality = this.evaluateQuality({
        text: text === 'OCR_EMPTY' ? '' : text,
        confidence: 95,
      }, config);

      if (!quality.enoughText && !quality.legibleShort) {
        return this.asFailedResult(quality, 'vision_fallback_empty');
      }

      return {
        text: quality.text,
        ocr: {
          status: 'vision_fallback',
          confidence: Math.round(quality.confidence),
          provider: `openai:${config.visionModel}`,
          usefulChars: quality.usefulChars,
          lineCount: quality.lineCount,
          localConfidence: localQuality?.confidence ?? null,
        },
      };
    } catch (error) {
      return {
        text: '',
        ocr: {
          status: 'failed',
          confidence: 0,
          provider: `openai:${config.visionModel}`,
          reason: error?.message || 'vision_fallback_failed',
          localConfidence: localQuality?.confidence ?? null,
        },
      };
    }
  }

  asLocalResult(localResult) {
    const quality = localResult.quality;
    return {
      text: quality.text,
      ocr: {
        status: 'local_ok',
        confidence: Math.round(quality.confidence),
        provider: 'tesseract',
        usefulChars: quality.usefulChars,
        lineCount: quality.lineCount,
        variants: localResult.variants || null,
      },
    };
  }

  asFailedResult(quality, error, extra = {}) {
    return {
      text: '',
      ocr: {
        status: 'failed',
        confidence: Math.round(Number(quality?.confidence || 0)),
        provider: 'tesseract',
        usefulChars: quality?.usefulChars || 0,
        lineCount: quality?.lineCount || 0,
        reason: error || quality?.reason || 'ocr_failed',
        ...extra,
      },
    };
  }

  normalizeText(text) {
    return normalizeOcrText(text);
  }
}

module.exports = new OcrEngine();
