/**
 * document-context — robust document analysis wrapper for the agent system.
 *
 * Bridges the existing document-intelligence pipeline with the new agent
 * platform (providers, logging, tracing). Provides:
 *   - Retry with exponential backoff for transient analysis failures
 *   - Structured error reporting (never silent)
 *   - Content validation with fallback analysis strategies
 *   - Agent context injection: converts file records → structured context
 *     blocks that the LLM can reason over
 *   - Hierarchical context for large documents (outline → summary → detail)
 *   - Health check: detects stuck/failed documents and surfaces recoverable
 *     diagnostics
 *
 * Every public method returns a { ok, result|error } envelope. Callers
 * never receive an unhandled exception from this module.
 */

const crypto = require('crypto');
const path = require('path');
const { getLogger } = require('./structured-logger');
const { getTracer } = require('./performance-tracer');

const fileProcessingStatus = require('../file-processing-status');
const documentIntelligence = require('../document-intelligence');
const fileProcessor = require('../fileProcessor');

// ── Configuration ───────────────────────────────────────────────
const MAX_RETRIES = Number.parseInt(process.env.SIRAGPT_DOC_ANALYSIS_RETRIES || '3', 10);
const RETRY_BASE_MS = Number.parseInt(process.env.SIRAGPT_DOC_ANALYSIS_RETRY_MS || '1000', 10);
const MIN_CONTENT_CHARS = Number.parseInt(process.env.SIRAGPT_DOC_MIN_CONTENT_CHARS || '80', 10);
const AGENT_CONTEXT_MAX_CHARS = Number.parseInt(process.env.SIRAGPT_DOC_AGENT_CONTEXT_CHARS || '80000', 10);
const MAX_CHUNKS_IN_CONTEXT = Number.parseInt(process.env.SIRAGPT_DOC_AGENT_MAX_CHUNKS || '20', 10);

// Hierarchical context config for large documents
const HIERARCHICAL_OUTLINE_CHARS = Number.parseInt(process.env.SIRAGPT_HIERARCHICAL_OUTLINE_CHARS || '4000', 10);
const HIERARCHICAL_SUMMARY_CHARS = Number.parseInt(process.env.SIRAGPT_HIERARCHICAL_SUMMARY_CHARS || '8000', 10);

let _hierarchicalChunker;
let _hierarchicalChunkerTried = false;
function getHierarchicalChunker() {
  if (_hierarchicalChunkerTried) return _hierarchicalChunker || null;
  _hierarchicalChunkerTried = true;
  try { _hierarchicalChunker = require('../document/hierarchical-document-chunker'); } catch { _hierarchicalChunker = null; }
  return _hierarchicalChunker;
}

let _streamingPdf;
let _streamingPdfTried = false;
function getStreamingPdf() {
  if (_streamingPdfTried) return _streamingPdf || null;
  _streamingPdfTried = true;
  try { _streamingPdf = require('../document/streaming-pdf'); } catch { _streamingPdf = null; }
  return _streamingPdf;
}

const log = getLogger('document-context');

// ── Helpers ─────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelay(attempt) {
  const base = RETRY_BASE_MS * Math.pow(2, attempt);
  const jitter = base * 0.2 * (Math.random() * 2 - 1);
  return Math.round(Math.max(base + jitter, 500));
}

function hasMeaningfulContent(text) {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length < MIN_CONTENT_CHARS) return false;

  const errorPatterns = [
    /^error processing/i,
    /^no text (extracted|detected|found)/i,
    /^failed to (extract|process|read|parse)/i,
    /^unable to (extract|read|process)/i,
    /^could not (extract|read|process)/i,
    /^processing error/i,
  ];
  if (errorPatterns.some((p) => p.test(trimmed.slice(0, 100)))) return false;

  const alphaNum = (trimmed.match(/[A-Za-z0-9ÁÉÍÓÚáéíóúÑñÜü]/g) || []).length;
  if (alphaNum < 20) return false;

  const usefulRatio = alphaNum / trimmed.length;
  return usefulRatio > 0.15;
}

function withSpan(tracer, name, fn) {
  const span = tracer.start ? tracer.start(name) : { traceId: 'noop', spanId: 'noop', startTime: Date.now() };
  const safeSpan = {
    traceId: span.traceId || 'noop',
    spanId: span.spanId || 'noop',
    startTime: span.startTime || Date.now(),
    setAttribute: () => {},
    addEvent: () => {},
    setStatus: () => {},
    end: () => {
      if (tracer.end && span.traceId) tracer.end(span);
    },
  };

  const resultP = (async () => {
    try {
      const result = await fn(safeSpan);
      safeSpan.end();
      return result;
    } catch (err) {
      safeSpan.setStatus({ code: 2, message: err.message || 'unknown' });
      safeSpan.end();
      throw err;
    }
  })();

  return resultP;
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Analyze a file with retry and structured error reporting.
 */
async function analyzeWithRetry(prisma, opts = {}) {
  const { userId, fileId, fileRecord, extractionResult, force = false, maxRetries = MAX_RETRIES } = opts;
  const tracer = getTracer();

  return withSpan(tracer, 'document-context.analyzeWithRetry', async (span) => {
    const ctx = {
      userId,
      fileId: fileId || fileRecord?.id || 'unknown',
      fileName: fileRecord?.originalName || fileRecord?.filename || 'unknown',
    };
    span.setAttribute('file.id', ctx.fileId);
    span.setAttribute('file.name', ctx.fileName);

    try {
      if (!prisma) {
        span.setStatus({ code: 2, message: 'no prisma client' });
        return { ok: false, error: 'Document context requires Prisma client', code: 'no_prisma' };
      }
      if (!userId) {
        span.setStatus({ code: 2, message: 'no userId' });
        return { ok: false, error: 'User identification required for document analysis', code: 'no_user' };
      }

      let file = fileRecord;
      if (!file && fileId) {
        file = await prisma.file.findFirst({ where: { id: fileId, userId } });
      }
      if (!file) {
        span.setStatus({ code: 2, message: 'file not found' });
        return { ok: false, error: `File${fileId ? ` ${fileId}` : ''} not found`, code: 'file_not_found' };
      }

      const currentText = file.extractedText;
      if (!hasMeaningfulContent(currentText)) {
        const reExtracted = await attemptReExtraction(prisma, file, userId, tracer);
        if (reExtracted.ok) {
          file = { ...file, extractedText: reExtracted.text };
        } else {
          log.warn('[document-context] no meaningful content', {
            fileId: file.id,
            fileName: file.originalName,
            chars: (currentText || '').length,
            reason: reExtracted.reason || 'empty_or_garbage',
          });
          span.setAttribute('extraction.empty', true);
          span.setAttribute('extraction.reason', reExtracted.reason || 'empty');
          span.setStatus({ code: 2, message: 'no meaningful content' });
          return {
            ok: false,
            error: reExtracted.reason === 'file_not_found'
              ? 'El archivo ya no existe en el disco'
              : 'No se pudo extraer texto significativo del documento',
            code: reExtracted.reason === 'file_not_found' ? 'file_missing' : 'empty_content',
            diagnostics: {
              charCount: (currentText || '').length,
              hasFileOnDisk: reExtracted.fileExists,
              reExtractionAttempted: reExtracted.attempted,
            },
          };
        }
      }

      let lastError = null;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          span.setAttribute('analysis.attempt', attempt);

          const analysis = await documentIntelligence.analyzeFile(prisma, {
            userId,
            fileRecord: file,
            extractionResult: extractionResult || null,
            force,
          });

          if (analysis) {
            span.setAttribute('analysis.status', analysis.status || 'unknown');
            span.setAttribute('analysis.chunkCount', analysis.chunkCount || 0);
            span.setAttribute('analysis.tableCount', analysis.tableCount || 0);

            if (analysis.chunkCount > 0 && analysis.status === 'ready') {
              await fileProcessingStatus
                .setStage(prisma, file.id, 'ready', { userId })
                .catch(() => {});
            }

            span.setStatus({ code: 1 });
            log.info('[document-context] analysis complete', {
              fileId: file.id,
              fileName: file.originalName,
              status: analysis.status,
              chunks: analysis.chunkCount,
              tables: analysis.tableCount,
              attempts: attempt + 1,
            });

            return { ok: true, result: analysis };
          }

          span.setStatus({ code: 2, message: 'analysis returned null' });
          return {
            ok: false,
            error: 'No se pudo analizar el documento (no se generaron fragmentos)',
            code: 'analysis_empty',
            diagnostics: { charCount: (file.extractedText || '').length },
          };
        } catch (err) {
          lastError = err;
          const isTransient = isTransientError(err);

          if (attempt < maxRetries && isTransient) {
            const delay = backoffDelay(attempt);
            log.warn('[document-context] analysis transient error, retrying', {
              attempt,
              maxRetries,
              delay,
              error: err.message || String(err),
            });
            span.addEvent('retry', { attempt, delay });
            await sleep(delay);
            continue;
          }

          const finalMsg = isTransient
            ? `El analisis del documento fallo despues de ${maxRetries + 1} intentos`
            : `Error en el analisis del documento: ${err.message || 'error desconocido'}`;

          await fileProcessingStatus
            .setStage(prisma, file.id, 'failed', {
              userId,
              error: `analysis: ${err && err.message ? err.message.slice(0, 200) : 'unknown'}`,
            })
            .catch(() => {});

          span.setStatus({ code: 2, message: err.message || 'analysis_error' });
          log.error('[document-context] analysis failed', {
            fileId: file.id,
            fileName: file.originalName,
            error: err.message || String(err),
            attempts: attempt + 1,
          });

          return {
            ok: false,
            error: finalMsg,
            code: isTransient ? 'analysis_timeout' : 'analysis_error',
            diagnostics: {
              attempts: attempt + 1,
              lastError: err.message ? err.message.slice(0, 300) : String(err).slice(0, 300),
              stage: 'analysis',
            },
          };
        }
      }

      span.setStatus({ code: 2, message: 'unreachable' });
      return { ok: false, error: 'Unexpected error in analysis retry loop', code: 'internal' };
    } catch (outerErr) {
      span.setStatus({ code: 2, message: outerErr.message || 'unexpected' });
      log.error('[document-context] unexpected error in analyzeWithRetry', {
        error: outerErr.message || String(outerErr),
        ctx,
      });
      return {
        ok: false,
        error: `Error inesperado: ${outerErr.message || 'error interno'}`,
        code: 'internal_error',
        diagnostics: { detail: String(outerErr).slice(0, 500) },
      };
    }
  });
}

async function attemptReExtraction(prisma, file, userId, tracer = null) {
  const span = tracer?.startSpan?.('document-context.attemptReExtraction');
  try {
    const fileExists = file.path && require('fs').existsSync(file.path);
    span?.setAttribute('file.path', file.path || '');
    span?.setAttribute('file.exists', fileExists);

    if (!fileExists) {
      span?.setStatus({ code: 2, message: 'file not found on disk' });
      return { ok: false, reason: 'file_not_found', fileExists: false, attempted: false };
    }

    span?.setAttribute('reExtraction.attempted', true);
    log.info('[document-context] re-extracting text', {
      fileId: file.id,
      fileName: file.originalName,
      path: file.path,
    });

    const result = await fileProcessor.processFile({
      path: file.path,
      mimetype: file.mimeType,
      originalname: file.originalName || file.filename || 'file',
      size: file.size || 0,
    });

    if (result && result.extractedText && hasMeaningfulContent(result.extractedText)) {
      await prisma.file
        .update({
          where: { id: file.id },
          data: { extractedText: result.extractedText },
        })
        .catch(() => null);

      span?.setAttribute('reExtraction.chars', result.extractedText.length);
      span?.setStatus({ code: 1 });
      log.info('[document-context] re-extraction successful', {
        fileId: file.id,
        chars: result.extractedText.length,
      });

      return { ok: true, text: result.extractedText, fileExists: true, attempted: true };
    }

    span?.setStatus({ code: 2, message: 're-extraction produced no meaningful text' });
    return {
      ok: false,
      reason: result?.error || 'extraction_empty',
      fileExists: true,
      attempted: true,
      extractionError: result?.error || null,
    };
  } catch (err) {
    span?.setStatus({ code: 2, message: err.message });
    return {
      ok: false,
      reason: 're_extraction_failed',
      fileExists: file.path ? require('fs').existsSync(file.path) : false,
      attempted: true,
      extractionError: err.message || String(err),
    };
  } finally {
    span?.end();
  }
}

function isTransientError(err) {
  if (!err) return true;
  const msg = String(err.message || '').toLowerCase();
  const transientPatterns = [
    'timeout', 'timed out', 'connection', 'econnreset', 'econnrefused',
    'etimedout', 'eai_again', 'rate limit', '429', '503', '502',
    'too many requests', 'try again', 'resource temporarily',
    'deadlock', 'lock wait', 'retry', 'reconnect',
    'prisma', 'database', '500',
  ];
  if (err.status >= 500) return true;
  return transientPatterns.some((p) => msg.includes(p));
}

/**
 * Build a HIERARCHICAL document context block for the agent's system prompt.
 *
 * For large documents (1000+ pages), uses progressive loading strategy
 * inspired by how humans read: outline first, then summary, then detail-on-demand.
 *
 * Strategy selection based on document size:
 *   - Small (<30K chars): all chunks inline
 *   - Large (30K-100K chars): outline + summary + limited chunks
 *   - Massive (>100K chars): outline + progressive summary + representative chunks
 */
function buildAgentContextBlock(analysis, file, opts = {}) {
  const maxChars = opts.maxChars || AGENT_CONTEXT_MAX_CHARS;
  const maxChunks = opts.maxChunks || MAX_CHUNKS_IN_CONTEXT;

  if (!analysis || !file) {
    return { block: '', truncated: false, charCount: 0, strategy: 'empty' };
  }

  const fileName = file.originalName || file.filename || 'Documento';
  const fileType = file.mimeType || 'unknown';
  const charCount = analysis.charCount || 0;
  const chunkCount = analysis.chunkCount || 0;
  const tableCount = analysis.tableCount || 0;
  const language = analysis.language || 'unknown';

  // Strategy selection
  const isMassive = charCount > 100000;
  const isLarge = charCount > 30000;
  const strategy = isMassive ? 'massive' : (isLarge ? 'large' : 'small');

  const parts = [];
  let totalChars = 0;
  let truncated = false;

  // ── Step 1: Document header ──
  {
    const header = [
      '[' + fileName + '] (' + fileType + ')',
      'Tamano: ' + charCount.toLocaleString() + ' caracteres | ' + chunkCount + ' fragmentos | ' + tableCount + ' tablas | Idioma: ' + language,
      'Estrategia: ' + strategy,
      '---',
    ].join('\n');
    parts.push(header);
    totalChars += header.length;
  }

  // ── Step 2: Build document outline (for large/massive documents) ──
  let outline = null;
  let progressiveSummary = null;

  const hierMod = getHierarchicalChunker();
  if ((isLarge || isMassive) && hierMod && file.extractedText) {
    try {
      const hierarchy = hierMod.buildHierarchicalStructure(file, file.extractedText);
      if (hierarchy.outline) {
        outline = hierarchy.outline;
      }
      if (hierarchy.progressiveSummary) {
        progressiveSummary = hierarchy.progressiveSummary;
      }
    } catch (hierErr) {
      log.warn('[document-context] hierarchical outline failed:', hierErr.message);
    }
  }

  // Fallback outline from page structure
  if (!outline && getStreamingPdf() && analysis.chunks) {
    try {
      const pages = (analysis.chunks || [])
        .filter(function(c) { return c.pageNumber; })
        .map(function(c) {
          return { page: c.pageNumber, text: c.text || '', structure: {} };
        });
      if (pages.length > 0) {
        const mdOutline = getStreamingPdf().buildMarkdownOutline(pages);
        if (mdOutline) outline = mdOutline;
      }
    } catch (_) {}
  }

  // Inject outline
  if (outline) {
    const trimmedOutline = outline.length > HIERARCHICAL_OUTLINE_CHARS
      ? outline.slice(0, HIERARCHICAL_OUTLINE_CHARS - 80) + '\n... (truncated)'
      : outline;

    var outlineBlock = '\nEsquema del documento:\n' + trimmedOutline + '\n---';
    if (totalChars + outlineBlock.length <= maxChars) {
      parts.push(outlineBlock);
      totalChars += outlineBlock.length;
    } else {
      truncated = true;
    }
  }

  // ── Step 3: Progressive summary ──
  if ((isLarge || isMassive) && !truncated) {
    let summaryText = null;

    if (progressiveSummary) {
      summaryText = progressiveSummary.slice(0, HIERARCHICAL_SUMMARY_CHARS);
    } else if (analysis.summary) {
      summaryText = analysis.summary.slice(0, HIERARCHICAL_SUMMARY_CHARS);
    } else if (analysis.chunks && analysis.chunks.length > 0) {
      var firstC = analysis.chunks[0];
      var lastC = analysis.chunks[analysis.chunks.length - 1];
      var firstLbl = firstC.sectionTitle || firstC.sourceLabel || 'Inicio';
      var lastLbl = lastC.sectionTitle || lastC.sourceLabel || 'Final';
      summaryText = firstLbl + ':\n' + (firstC.text || '').slice(0, 2000) +
        '\n\n' + lastLbl + ':\n' + (lastC.text || '').slice(0, 1500);
    }

    if (summaryText) {
      var summaryBlock = '\nResumen progresivo:\n' + summaryText + '\n---';
      if (totalChars + summaryBlock.length <= maxChars) {
        parts.push(summaryBlock);
        totalChars += summaryBlock.length;
      } else {
        truncated = true;
      }
    }
  }

  // ── Step 4: Content chunks ──
  var remainingForChunks = maxChars - totalChars - 300;
  var maxChunksToInclude = maxChunks;

  if (isMassive && outline) {
    maxChunksToInclude = Math.min(maxChunksToInclude, 8);
  } else if (isLarge && outline) {
    maxChunksToInclude = Math.min(maxChunksToInclude, 12);
  }
  if (!isLarge) {
    maxChunksToInclude = Math.min((analysis.chunks || []).length, 30);
  }

  if (remainingForChunks > 0) {
    var chunks = (analysis.chunks || []).slice(0, maxChunksToInclude);
    for (var i = 0; i < chunks.length && remainingForChunks > 0; i++) {
      var chunk = chunks[i];
      var label = chunk.sectionTitle || chunk.sourceLabel || 'Fragmento ' + (chunk.ordinal || '?');
      var chunkText = (chunk.text || '').trim();
      if (!chunkText) continue;

      var sectionRef = chunk.sectionPath ? ' (' + chunk.sectionPath + ')' : '';
      var pageRef = chunk.pageNumber ? ' [p.' + chunk.pageNumber + ']' : '';

      var overhead = label.length + sectionRef.length + pageRef.length + 40;
      var available = remainingForChunks - overhead;
      if (available <= 0) {
        truncated = true;
        break;
      }

      var displayText = chunkText.length > available
        ? chunkText.slice(0, available - 3) + '...'
        : chunkText;

      var block = '\n[' + (chunk.ordinal || i + 1) + '] ' + label + pageRef + sectionRef + ':\n' + displayText;
      parts.push(block);
      totalChars += block.length;
      remainingForChunks -= block.length;
    }
  }

  // ── Step 5: Tables ──
  if (analysis.tables && analysis.tables.length > 0 && !truncated) {
    var remForTables = maxChars - totalChars;
    if (remForTables > 200) {
      var tableLines = [];
      tableLines.push('--- Tablas (' + analysis.tables.length + '):');
      var tbls = analysis.tables.slice(0, 5);
      for (var ti = 0; ti < tbls.length; ti++) {
        var t = tbls[ti];
        var loc = t.sheetName ? ' en "' + t.sheetName + '"' : '';
        var cols = t.columns ? t.columns.length : 0;
        var rows = t.rowCount || 0;
        var previewLen = t.markdown ? t.markdown.length : 0;
        tableLines.push('  - ' + (t.title || t.sourceLabel || 'Tabla ' + (ti + 1)) + loc + ': ' + cols + ' cols, ' + rows + ' filas' + (previewLen > 0 ? ', ' + previewLen + ' chars' : ''));
      }
      var tablesBlock = '\n' + tableLines.join('\n');
      if (tablesBlock.length <= remForTables) {
        parts.push(tablesBlock);
        totalChars += tablesBlock.length;
      }
    }
  }

  // ── Step 6: Compact footer ──
  if (!truncated) {
    var footer = '\n---\nDocumento cargado: ' + fileName + ' (' + chunkCount + ' fragmentos)';
    if (totalChars + footer.length <= maxChars) {
      parts.push(footer);
    }
  }

  return {
    block: parts.join('\n'),
    truncated: truncated,
    charCount: totalChars,
    strategy: strategy,
    outlineOnly: outline != null && chunks && chunks.length > 0 && !isLarge,
  };
}

/**
 * Perform a health check on a file's document analysis pipeline.
 */
async function diagnoseFile(prisma, opts = {}) {
  const { userId, fileId } = opts;
  const tracer = getTracer();

  return withSpan(tracer, 'document-context.diagnoseFile', async (span) => {
    span.setAttribute('file.id', fileId);
    span.setAttribute('user.id', userId);

    if (!prisma || !userId || !fileId) {
      return { ok: false, error: 'Missing required parameters', code: 'bad_request' };
    }

    const file = await prisma.file.findFirst({
      where: { id: fileId, userId },
      select: {
        id: true,
        originalName: true,
        filename: true,
        mimeType: true,
        size: true,
        path: true,
        extractedText: true,
        openaiFileId: true,
        processingStage: true,
        processingError: true,
        processingStageAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!file) {
      return { ok: false, error: 'File not found', code: 'file_not_found' };
    }

    const fileExists = file.path ? require('fs').existsSync(file.path) : false;
    const textChars = (file.extractedText || '').length;
    const hasUsefulText = hasMeaningfulContent(file.extractedText);
    const stage = file.processingStage || 'unknown';

    let analysisRecord = null;
    let chunkCount = 0;
    let tableCount = 0;
    try {
      analysisRecord = await prisma.documentAnalysis.findFirst({
        where: { userId, fileId: file.id },
        select: {
          id: true,
          status: true,
          charCount: true,
          chunkCount: true,
          tableCount: true,
          language: true,
          summary: true,
          updatedAt: true,
          _count: { select: { chunks: true, tables: true } },
        },
      });
      if (analysisRecord) {
        chunkCount = analysisRecord._count?.chunks || analysisRecord.chunkCount || 0;
        tableCount = analysisRecord._count?.tables || analysisRecord.tableCount || 0;
      }
    } catch {
      analysisRecord = null;
    }

    const status = determineHealthStatus(stage, hasUsefulText, !!analysisRecord, chunkCount);

    const diagnostics = {
      fileId: file.id,
      fileName: file.originalName || file.filename,
      mimeType: file.mimeType,
      size: file.size,
      fileExistsOnDisk: fileExists,
      processingStage: stage,
      processingError: file.processingError || null,
      stageUpdatedAt: file.processingStageAt,
      textExtractedChars: textChars,
      hasUsefulContent: hasUsefulText,
      analysisExists: !!analysisRecord,
      analysisStatus: analysisRecord?.status || null,
      analysisChunks: chunkCount,
      analysisTables: tableCount,
      health: status,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
    };

    span.setAttribute('health', status);
    span.setAttribute('stage', stage);
    span.setAttribute('hasUsefulText', hasUsefulText);

    const canRepair = ['stuck', 'failed_analysis', 'empty_extraction', 'failed'].includes(status);

    return {
      ok: true,
      result: {
        diagnostics,
        canRepair,
        recommendedAction: canRepair ? getRecommendedAction(status) : null,
      },
    };
  });
}

function determineHealthStatus(stage, hasUsefulText, hasAnalysis, chunkCount) {
  if (stage === 'failed') return 'failed';
  if (stage === 'ready' && !hasUsefulText) return 'empty_extraction';
  if (stage === 'ready' && hasUsefulText && !hasAnalysis) return 'missing_analysis';
  if (stage === 'ready' && hasAnalysis && chunkCount === 0) return 'empty_analysis';
  if (stage === 'ready' && hasAnalysis && chunkCount > 0) return 'healthy';

  const stuckStages = ['uploaded', 'validating', 'extracting', 'chunking', 'embedding', 'indexing'];
  if (stuckStages.includes(stage)) return 'stuck';

  return 'unknown';
}

function getRecommendedAction(status) {
  const actions = {
    stuck: 'El archivo parece estar atascado en una etapa de procesamiento. Re-analiza el documento.',
    failed: 'El analisis del documento fallo. Revisa el log de errores y re-analiza.',
    empty_extraction: 'No se pudo extraer texto del archivo. Prueba con un formato diferente o verifica que el archivo no este danado.',
    missing_analysis: 'El texto fue extraido pero no se genero el analisis. Re-analiza el documento.',
    empty_analysis: 'El analisis no produjo fragmentos. El documento podria no tener contenido textual util.',
    failed_analysis: 'El analisis fallo debido a un error interno.',
  };
  return actions[status] || 'Estado desconocido. Contacta al equipo de soporte.';
}

/**
 * Full repair pipeline: re-extract text, re-analyze, re-index RAG.
 */
async function repairDocument(prisma, ragService, opts = {}) {
  const { userId, fileId } = opts;
  const tracer = getTracer();

  return withSpan(tracer, 'document-context.repairDocument', async (span) => {
    span.setAttribute('file.id', fileId);
    span.setAttribute('user.id', userId);

    const diagnosis = await diagnoseFile(prisma, { userId, fileId });
    if (!diagnosis.ok) {
      span.setStatus({ code: 2, message: 'diagnosis failed' });
      return { ok: false, error: diagnosis.error, code: diagnosis.code || 'diagnosis_failed' };
    }

    const { diagnostics } = diagnosis.result;
    span.setAttribute('diagnosis.health', diagnostics.health);

    const file = await prisma.file.findFirst({ where: { id: fileId, userId } });
    if (!file) {
      return { ok: false, error: 'File not found during repair', code: 'file_not_found' };
    }

    if (!hasMeaningfulContent(file.extractedText)) {
      log.info('[document-context] repair: re-extracting text', { fileId, fileName: file.originalName });
      await fileProcessingStatus.setStage(prisma, file.id, 'extracting', { userId });

      const reExtract = await attemptReExtraction(prisma, file, userId, tracer);
      if (!reExtract.ok) {
        span.setStatus({ code: 2, message: 're-extraction failed' });
        return {
          ok: false,
          error: reExtract.extractionError
            ? 'Re-extraccion fallo: ' + reExtract.extractionError
            : 'No se pudo re-extraer el texto del archivo',
          code: 're_extraction_failed',
          diagnostics: { reExtractReason: reExtract.reason },
        };
      }
      file.extractedText = reExtract.text;
    }

    const analysisResult = await analyzeWithRetry(prisma, {
      userId,
      fileRecord: file,
      force: true,
    });

    if (!analysisResult.ok) {
      span.setStatus({ code: 2, message: 'analysis failed during repair' });
      return {
        ok: false,
        error: analysisResult.error,
        code: analysisResult.code || 'analysis_failed',
        diagnostics: analysisResult.diagnostics || null,
      };
    }

    if (ragService && file.extractedText) {
      try {
        const operationalRag = require('../rag/operational-runtime');
        const docs = operationalRag.normaliseDocs([file]);
        if (docs.length > 0) {
          await operationalRag.ensureIndexed({
            rag: ragService,
            userId,
            collection: operationalRag.DEFAULT_COLLECTION,
            docs,
          });
        }
      } catch (ragErr) {
        log.warn('[document-context] RAG re-index non-fatal error', {
          fileId,
          error: ragErr.message || String(ragErr),
        });
      }
    }

    await fileProcessingStatus
      .setStage(prisma, file.id, 'ready', { userId })
      .catch(() => null);

    span.setStatus({ code: 1 });
    log.info('[document-context] repair complete', {
      fileId,
      fileName: file.originalName,
      status: analysisResult.result?.status,
    });

    return {
      ok: true,
      result: {
        fileName: file.originalName,
        analysis: analysisResult.result,
        diagnostics: diagnosis.result.diagnostics,
      },
    };
  });
}

/**
 * Batch diagnose all files for a user.
 */
async function batchDiagnose(prisma, userId) {
  const tracer = getTracer();
  return withSpan(tracer, 'document-context.batchDiagnose', async (span) => {
    span.setAttribute('user.id', userId);

    const files = await prisma.file.findMany({
      where: { userId },
      select: {
        id: true,
        originalName: true,
        mimeType: true,
        size: true,
        processingStage: true,
        processingError: true,
        processingStageAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    const results = [];
    for (const file of files) {
      const fileExists = file.path ? require('fs').existsSync(file.path) : false;
      const stage = file.processingStage || 'unknown';
      const stuckStages = ['uploaded', 'validating', 'extracting', 'chunking', 'embedding', 'indexing'];
      const isStuck = stuckStages.includes(stage) &&
        file.processingStageAt &&
        (Date.now() - new Date(file.processingStageAt).getTime() > 5 * 60 * 1000);

      results.push({
        fileId: file.id,
        name: file.originalName,
        mimeType: file.mimeType,
        size: file.size,
        stage,
        error: file.processingError || null,
        fileExistsOnDisk: fileExists,
        isStuck,
        stageAgeMinutes: file.processingStageAt
          ? Math.round((Date.now() - new Date(file.processingStageAt).getTime()) / 60000)
          : null,
        createdAt: file.createdAt,
      });
    }

    const summary = {
      total: results.length,
      healthy: results.filter(function(r) { return r.stage === 'ready' && !r.error; }).length,
      stuck: results.filter(function(r) { return r.isStuck; }).length,
      failed: results.filter(function(r) { return r.stage === 'failed'; }).length,
      processing: results.filter(function(r) {
        return !r.isStuck && ['uploaded', 'validating', 'extracting', 'chunking', 'embedding', 'indexing'].includes(r.stage);
      }).length,
      missingFromDisk: results.filter(function(r) { return r.stage === 'ready' && !r.fileExistsOnDisk; }).length,
    };

    span.setAttribute('results.total', summary.total);
    span.setAttribute('results.healthy', summary.healthy);
    span.setStatus({ code: 1 });

    return {
      ok: true,
      result: { summary, files: results },
    };
  });
}

module.exports = {
  analyzeWithRetry,
  attemptReExtraction,
  buildAgentContextBlock,
  diagnoseFile,
  repairDocument,
  batchDiagnose,
  hasMeaningfulContent,
  __test__: {
    backoffDelay,
    isTransientError,
    determineHealthStatus,
    getRecommendedAction,
  },
};
