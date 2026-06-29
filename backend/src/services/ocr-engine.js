const { createWorker } = require('tesseract.js');
const sharp = require('sharp');
const fs = require('fs').promises;
const OpenAI = require('openai');

const OCR_PLACEHOLDER_RE = /^(no text found in image|no text detected(?: in image pdf)?|no content available|binary file|file content could not be extracted|file ".*?" uploaded successfully|error processing file:|unsupported file type)/i;

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function positiveIntFromEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function boundedIntFromEnv(name, fallback, min, max) {
  const value = positiveIntFromEnv(name, fallback);
  return Math.max(min, Math.min(value, max));
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
      pdfMaxPages: numberFromEnv('OCR_PDF_MAX_PAGES', 0),
      pdfMaxChars: positiveIntFromEnv('OCR_PDF_MAX_CHARS', 6_000_000),
      pdfScale: numberFromEnv('OCR_PDF_RENDER_SCALE', 2.4),
      pdfMaxSide: positiveIntFromEnv('OCR_PDF_MAX_SIDE', 2600),
      pdfMaxVariants: boundedIntFromEnv('OCR_PDF_MAX_VARIANTS', 4, 1, 5),
      pdfDeepVariantPages: boundedIntFromEnv('OCR_PDF_DEEP_VARIANT_PAGES', 60, 1, 1000),
      pdfPageMetaLimit: boundedIntFromEnv('OCR_PDF_PAGE_META_LIMIT', 200, 1, 2000),
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

    if (options.streaming !== false) {
      return this.extractFromPdfImagesStreaming(filePath, options);
    }

    const pageBuffers = await this.renderPdfPages(filePath, options);
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

  /**
   * Returns an ordered list of lazy variant factories. Each factory
   * produces a preprocessed image buffer on demand so callers that
   * early-exit (e.g. a clean screenshot accepted on variant 1) never
   * pay the sharp cost of generating variants they won't OCR.
   * Order matters: variant 1 (normalize+sharpen) handles the common
   * well-lit / screenshot case, so it runs first.
   */
  createImageVariantFactories(input, options = {}) {
    const maxSide = options.maxSide || 3000;
    const makeBase = () => sharp(input)
      .rotate()
      .resize(maxSide, maxSide, { fit: 'inside', withoutEnlargement: false })
      .greyscale();

    return [
      // 1. Normalize + sharpen (best for well-lit documents / screenshots)
      { name: 'normalize_sharpen', make: () => makeBase().normalize().sharpen().png().toBuffer() },
      // 2. High contrast — linear stretch (best for faded text)
      { name: 'contrast_sharpen', make: () => makeBase().linear(1.25, -8).normalize().sharpen().png().toBuffer() },
      // 3. Hard threshold binarization (best for clean scans)
      { name: 'threshold_165', make: () => makeBase().normalize().threshold(165).png().toBuffer() },
      // 4. Adaptive threshold via local contrast (best for uneven lighting)
      { name: 'adaptive_threshold', make: () => this._adaptiveThreshold(makeBase()) },
      // 5. Inverted — white text on black (important for some diagrams)
      { name: 'inverted_normalized', make: () => makeBase().negate({ alpha: false }).normalize().sharpen().png().toBuffer() },
    ];
  }

  createImageVariants(filePath) {
    return this.createImageVariantFactories(filePath, { maxSide: 3000 });
  }

  createPdfPageVariants(pageBuffer, config = this.config) {
    return this.createImageVariantFactories(pageBuffer, {
      maxSide: config.pdfMaxSide || 2600,
    });
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

  scoreQuality(quality = {}) {
    const usefulChars = Number(quality.usefulChars || 0);
    const confidence = Number(quality.confidence || 0);
    const lineCount = Number(quality.lineCount || 0);
    const acceptedBoost = quality.accepted ? 500 : 0;
    return usefulChars * 2 + confidence + Math.min(lineCount, 80) + acceptedBoost;
  }

  async recognizeBestVariant(worker, variantFactories, config = this.config, options = {}) {
    let best = this.evaluateQuality({ text: '', confidence: 0 });
    let bestVariant = null;
    let variantsProcessed = 0;
    const maxVariants = Math.max(1, Math.min(
      Number.parseInt(options.maxVariants || variantFactories.length, 10) || variantFactories.length,
      variantFactories.length,
    ));
    let lastError = null;

    for (let idx = 0; idx < maxVariants; idx += 1) {
      const entry = variantFactories[idx];
      const makeVariant = typeof entry === 'function' ? entry : entry.make;
      const variantName = typeof entry === 'function' ? `variant_${idx + 1}` : entry.name;
      try {
        const variant = await makeVariant();
        const { data: { text, confidence } } = await worker.recognize(variant);
        variantsProcessed += 1;
        const quality = this.evaluateQuality({ text, confidence }, config);
        if (this.scoreQuality(quality) > this.scoreQuality(best)) {
          best = quality;
          bestVariant = variantName;
        }
      } catch (err) {
        lastError = err;
        continue;
      }
      // Early-exit: a clean screenshot / page is usually accepted on the first
      // normalized pass. Low-quality pages continue through contrast/threshold
      // variants, which is the path that recovers scans and photocopies.
      if (best.accepted) break;
    }

    if (variantsProcessed === 0 && lastError) throw lastError;
    return { quality: best, variants: variantsProcessed, variant: bestVariant };
  }

  async runLocalImageOcr(filePath, options = {}) {
    const variantFactories = this.createImageVariants(filePath);
    const worker = await createWorker(options.language || this.defaultLanguage);

    try {
      return await this.recognizeBestVariant(worker, variantFactories, this.config, {
        maxVariants: variantFactories.length,
      });
    } finally {
      await worker.terminate();
    }
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

  async preprocessPdfPage(page, config = this.config) {
    return sharp(page)
      .rotate()
      .resize(config.pdfMaxSide || 2600, config.pdfMaxSide || 2600, { fit: 'inside', withoutEnlargement: false })
      .greyscale()
      .normalize()
      .sharpen()
      .png()
      .toBuffer();
  }

  async renderPdfPages(filePath, options = {}) {
    const config = this.config;
    const { pdf } = await import('pdf-to-img');
    const pages = await pdf(filePath, { scale: options.scale || config.pdfScale || 2.4 });
    const buffers = [];
    const maxPages = Number.parseInt(options.maxPages ?? config.pdfMaxPages ?? 0, 10) || 0;
    let pageNumber = 0;

    for await (const page of pages) {
      pageNumber += 1;
      if (maxPages > 0 && pageNumber > maxPages) break;
      const buffer = await this.preprocessPdfPage(page, config);
      buffers.push(buffer);
    }

    return buffers;
  }

  async extractFromPdfImagesStreaming(filePath, options = {}) {
    const config = this.config;
    const mode = String(options.mode || config.mode).toLowerCase();
    if (mode === 'off') return this.skipped('ocr_disabled');

    const { pdf } = await import('pdf-to-img');
    const pages = await pdf(filePath, { scale: options.scale || config.pdfScale || 2.4 });
    const maxPages = Number.parseInt(options.maxPages ?? config.pdfMaxPages ?? 0, 10) || 0;
    const maxChars = positiveIntFromEnv('OCR_PDF_MAX_CHARS', config.pdfMaxChars || 6_000_000);
    const language = options.language || this.defaultLanguage;
    const onPage = typeof options.onPage === 'function' ? options.onPage : null;
    const worker = await createWorker(language);
    const pageResults = [];
    const textParts = [];
    const startedAt = Date.now();
    let pageNumber = 0;
    let processedPages = 0;
    let totalUsefulChars = 0;
    let totalConfidence = 0;
    let acceptedConfidence = 0;
    let acceptedConfidenceSamples = 0;
    let maxVariantsSeen = 0;
    let outputChars = 0;
    let partial = false;
    let partialReason = null;

    try {
      if (typeof worker.setParameters === 'function') {
        await worker.setParameters({
          preserve_interword_spaces: '1',
          tessedit_pageseg_mode: '1',
        }).catch(() => null);
      }
      for await (const page of pages) {
        pageNumber += 1;
        if (maxPages > 0 && pageNumber > maxPages) {
          partial = true;
          partialReason = 'page_cap';
          break;
        }

        const variantFactories = this.createPdfPageVariants(page, config);
        const pageVariantLimit = pageNumber <= config.pdfDeepVariantPages
          ? config.pdfMaxVariants
          : 1;
        const localResult = await this.recognizeBestVariant(worker, variantFactories, config, {
          maxVariants: pageVariantLimit,
        });
        const quality = localResult.quality;
        maxVariantsSeen = Math.max(maxVariantsSeen, localResult.variants || 0);
        const pageResult = {
          page: pageNumber,
          text: quality.text,
          confidence: Number(quality.confidence || 0),
          usefulChars: quality.usefulChars,
          lineCount: quality.lineCount,
          accepted: quality.accepted || quality.enoughText || quality.legibleShort,
          reason: quality.reason,
          variant: localResult.variant,
          variants: localResult.variants,
          deep: pageVariantLimit > 1,
        };
        pageResults.push(pageResult);
        processedPages += 1;
        totalUsefulChars += quality.usefulChars;
        totalConfidence += Number(quality.confidence || 0);
        if (pageResult.accepted && pageResult.text) {
          acceptedConfidence += Number(quality.confidence || 0);
          acceptedConfidenceSamples += 1;
        }

        if (pageResult.accepted && pageResult.text) {
          const pageBlock = `[page ${pageNumber}]\n${pageResult.text}`;
          const separatorChars = textParts.length > 0 ? 2 : 0;
          if (outputChars + separatorChars + pageBlock.length > maxChars) {
            partial = true;
            partialReason = 'char_cap';
            break;
          }
          textParts.push(pageBlock);
          outputChars += separatorChars + pageBlock.length;
        }

        if (onPage) {
          await onPage({
            page: pageNumber,
            processedPages,
            usefulChars: quality.usefulChars,
            confidence: Number(quality.confidence || 0),
            accepted: pageResult.accepted,
            variant: pageResult.variant,
            variants: pageResult.variants,
          });
        }
      }
    } finally {
      await worker.terminate();
    }

    const joinedText = normalizeOcrText(textParts.join('\n\n'));
    const avgConfidence = processedPages ? totalConfidence / processedPages : 0;
    const textConfidence = acceptedConfidenceSamples ? acceptedConfidence / acceptedConfidenceSamples : avgConfidence;
    const quality = this.evaluateQuality({ text: joinedText, confidence: textConfidence }, config);
    const acceptedPages = pageResults.filter(page => page.accepted && page.text).length;
    const blankPages = pageResults.filter(page => page.usefulChars === 0).length;
    const weakPages = pageResults.filter(page => page.usefulChars > 0 && !page.accepted).length;
    const pageMeta = pageResults
      .slice(0, config.pdfPageMetaLimit)
      .map(page => ({
        page: page.page,
        confidence: Math.round(Number(page.confidence || 0)),
        usefulChars: page.usefulChars,
        lineCount: page.lineCount,
        accepted: Boolean(page.accepted),
        reason: page.reason,
        variant: page.variant,
        variants: page.variants,
      }));
    const omittedPageMeta = Math.max(0, pageResults.length - pageMeta.length);

    if (quality.enoughText || quality.legibleShort) {
      return {
        text: quality.text,
        pages: pageResults,
        ocr: {
          status: 'local_ok',
          confidence: Math.round(avgConfidence),
          provider: 'tesseract',
          usefulChars: totalUsefulChars,
          lineCount: quality.lineCount,
          pages: processedPages,
          pagesWithText: acceptedPages,
          blankPages,
          weakPages,
          streaming: true,
          partial,
          partialReason,
          elapsedMs: Date.now() - startedAt,
          language,
          maxPages: maxPages || null,
          mode: 'local_multipass',
          maxVariants: config.pdfMaxVariants,
          maxVariantsSeen,
          deepVariantPages: config.pdfDeepVariantPages,
          pageQuality: pageMeta,
          omittedPageQuality: omittedPageMeta,
        },
      };
    }

    return this.asFailedResult(quality, 'local_pdf_ocr_empty', {
      pages: processedPages,
      pagesWithText: acceptedPages,
      blankPages,
      weakPages,
      streaming: true,
      partial,
      partialReason,
      elapsedMs: Date.now() - startedAt,
      mode: 'local_multipass',
      maxVariants: config.pdfMaxVariants,
      maxVariantsSeen,
      deepVariantPages: config.pdfDeepVariantPages,
      pageQuality: pageMeta,
      omittedPageQuality: omittedPageMeta,
    });
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
