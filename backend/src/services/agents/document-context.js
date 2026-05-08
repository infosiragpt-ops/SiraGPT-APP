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

const log = getLogger('document-context');

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Sleep for `ms` milliseconds. Used in retry loops.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compute exponential backoff delay for retry `attempt` (0-indexed).
 * Base × 2^attempt + jitter (±20%).
 */
function backoffDelay(attempt) {
  const base = RETRY_BASE_MS * Math.pow(2, attempt);
  const jitter = base * 0.2 * (Math.random() * 2 - 1); // ±20%
  return Math.round(Math.max(base + jitter, 500));
}

/**
 * Check whether extracted text has genuinely useful content beyond
 * boilerplate, error messages, or a single line of garbage.
 */
function hasMeaningfulContent(text) {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length < MIN_CONTENT_CHARS) return false;

  // Reject pure error messages masquerading as extracted text
  const errorPatterns = [
    /^error processing/i,
    /^no text (extracted|detected|found)/i,
    /^failed to (extract|process|read|parse)/i,
    /^unable to (extract|read|process)/i,
    /^could not (extract|read|process)/i,
    /^processing error/i,
  ];
  if (errorPatterns.some((p) => p.test(trimmed.slice(0, 100)))) return false;

  // Must contain at least some alphanumeric characters (not just symbols/whitespace)
  const alphaNum = (trimmed.match(/[A-Za-z0-9ÁÉÍÓÚáéíóúÑñÜü]/g) || []).length;
  if (alphaNum < 20) return false;

  // Ratio of useful characters must be > 15% (otherwise it's mostly symbols/digits/noise)
  const usefulRatio = alphaNum / trimmed.length;
  return usefulRatio > 0.15;
}

// ── Span helper (safe fallback when tracer is not initialised) ─
// Wraps tracer.start()/end() so we don't depend on a custom
// startActiveSpan method that may not exist in all tracer versions.
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
 *
 * Wraps `documentIntelligence.analyzeFile` with:
 *   - Retry loop (exponential backoff) for transient DB/network failures
 *   - Content validation: if extracted text is empty or garbage, returns
 *     a clear diagnostic instead of "skipped"
 *   - Trace event emission for observability
 *
 * @param {object} prisma - Prisma client
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} [opts.fileId]
 * @param {object} [opts.fileRecord]  - Pre-fetched file row (avoids extra query)
 * @param {object} [opts.extractionResult] - Result from fileProcessor.processFile
 * @param {boolean} [opts.force=false] - Force re-analysis even if cached
 * @param {number} [opts.maxRetries=MAX_RETRIES]
 * @returns {Promise<{ok: boolean, result?: object, error?: string, code?: string}>}
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
      // ── Input validation ──
      if (!prisma) {
        span.setStatus({ code: 2, message: 'no prisma client' });
        return { ok: false, error: 'Document context requires Prisma client', code: 'no_prisma' };
      }
      if (!userId) {
        span.setStatus({ code: 2, message: 'no userId' });
        return { ok: false, error: 'User identification required for document analysis', code: 'no_user' };
      }

      // ── Fetch file record if not provided ──
      let file = fileRecord;
      if (!file && fileId) {
        file = await prisma.file.findFirst({ where: { id: fileId, userId } });
      }
      if (!file) {
        span.setStatus({ code: 2, message: 'file not found' });
        return { ok: false, error: `File${fileId ? ` ${fileId}` : ''} not found`, code: 'file_not_found' };
      }

      // ── Check if extracted text exists and is meaningful ──
      const currentText = file.extractedText;
      if (!hasMeaningfulContent(currentText)) {
        // Attempt re-extraction if the file still exists on disk
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

      // ── Run analysis with retry ──
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

            // Mark as ready if analysis produced chunks
            if (analysis.chunkCount > 0 && analysis.status === 'ready') {
              await fileProcessingStatus
                .setStage(prisma, file.id, 'ready', { userId })
                .catch(() => { /* non-fatal */ });
            }

            span.setStatus({ code: 1 }); // OK
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

          // null analysis = no useful text even for the retry
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

          // Non-transient or exhausted retries
          const finalMsg = isTransient
            ? `El analisis del documento fallo después de ${maxRetries + 1} intentos`
            : `Error en el analisis del documento: ${err.message || 'error desconocido'}`;

          await fileProcessingStatus
            .setStage(prisma, file.id, 'failed', {
              userId,
              error: `analysis: ${err && err.message ? err.message.slice(0, 200) : 'unknown'}`,
            })
            .catch(() => { /* non-fatal */ });

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

      // Should not reach here, but TypeScript safety
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

/**
 * Attempt to re-extract text from a file that has empty or garbage
 * extractedText but still exists on disk.
 *
 * @returns {Promise<{ok: boolean, text?: string, reason?: string, fileExists?: boolean, attempted?: boolean}>}
 */
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
      // Update DB with fresh extracted text
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

/**
 * Check whether an error is likely transient (DB timeout, rate limit,
 * connection reset) vs permanent (schema mismatch, missing table).
 */
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
  // If it has a status code >= 500, it's transient server error
  if (err.status >= 500) return true;

  return transientPatterns.some((p) => msg.includes(p));
}

/**
 * Build a structured document context block for the agent's system prompt.
 *
 * Takes an analysis result + file record and produces a compact, cited
 * markdown block that the LLM can use for document-grounded reasoning.
 *
 * @param {object} analysis - Result from analyzeWithRetry (or analyzeFile)
 * @param {object} file - File record from Prisma
 * @param {object} [opts]
 * @param {number} [opts.maxChars=AGENT_CONTEXT_MAX_CHARS]
 * @param {number} [opts.maxChunks=MAX_CHUNKS_IN_CONTEXT]
 * @returns {{ block: string, truncated: boolean, charCount: number }}
 */
function buildAgentContextBlock(analysis, file, opts = {}) {
  const maxChars = opts.maxChars || AGENT_CONTEXT_MAX_CHARS;
  const maxChunks = opts.maxChunks || MAX_CHUNKS_IN_CONTEXT;

  if (!analysis || !file) {
    return { block: '', truncated: false, charCount: 0 };
  }

  const fileName = file.originalName || file.filename || 'Documento';
  const fileType = file.mimeType || 'unknown';
  const charCount = analysis.charCount || 0;
  const chunkCount = analysis.chunkCount || 0;
  const tableCount = analysis.tableCount || 0;
  const language = analysis.language || 'unknown';
  const status = analysis.status || 'unknown';
  const coverage = analysis.textCoverage?.extractionCoverage || 0;

  const parts = [];
  let totalChars = 0;
  let truncated = false;

  // Header
  const header = `📄 Document: ${fileName}
Type: ${fileType} | Language: ${language} | Status: ${status}
Chars: ${charCount.toLocaleString()} | Chunks: ${chunkCount} | Tables: ${tableCount}
${coverage > 0 ? `Text coverage: ${(coverage * 100).toFixed(0)}%` : ''}
───`;

  parts.push(header);
  totalChars += header.length;

  // Chunks (most relevant / earliest first)
  const chunks = (analysis.chunks || []).slice(0, maxChunks);
  for (const chunk of chunks) {
    if (totalChars >= maxChars) {
      truncated = true;
      break;
    }

    const label = chunk.sectionTitle || chunk.sourceLabel || `Fragmento ${chunk.ordinal || '?'}`;
    const chunkText = (chunk.text || '').trim();
    let available = maxChars - totalChars - label.length - 20; // room for formatting
    if (available <= 0) {
      truncated = true;
      break;
    }

    const displayText = chunkText.length > available
      ? chunkText.slice(0, available - 3) + '...'
      : chunkText;

    const block = `\n[${chunk.ordinal || '?'}] ${label}:\n${displayText}`;
    parts.push(block);
    totalChars += block.length;
  }

  // Tables summary (compact)
  if (analysis.tables && analysis.tables.length > 0 && !truncated) {
    const tablesBlock = `\n─── Tables (${analysis.tables.length}):\n` +
      analysis.tables
        .slice(0, 5)
        .map((t) => `  • ${t.title || t.sourceLabel || `Table ${t.ordinal}`}: ${(t.columns || []).length} cols, ${t.rowCount} rows`)
        .join('\n');

    const remaining = maxChars - totalChars;
    const trimTables = tablesBlock.length > remaining ? tablesBlock.slice(0, Math.max(remaining, 0)) : tablesBlock;
    parts.push(trimTables);
    totalChars += trimTables.length;
    if (trimTables.length < tablesBlock.length) truncated = true;
  }

  // Footer with summary
  if (!truncated && analysis.summary) {
    const summaryBlock = `\n─── Summary:\n${analysis.summary.slice(0, 600)}`;
    const remaining = maxChars - totalChars;
    if (summaryBlock.length <= remaining) {
      parts.push(summaryBlock);
    }
  }

  return {
    block: parts.join('\n'),
    truncated,
    charCount: totalChars,
  };
}

/**
 * Perform a health check on a file's document analysis pipeline.
 *
 * Examines the file record, extracted text, analysis DB records, and
 * processing stage to produce a complete diagnostic report.
 *
 * @param {object} prisma
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.fileId
 * @returns {Promise<{ok: boolean, result?: object, error?: string}>}
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

    // Fetch analysis record
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
      // analysis table might not exist
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

    const canRepair = status === 'stuck' || status === 'failed_analysis' || status === 'empty_extraction' || status === 'failed';

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

/**
 * Determine overall health status from pipeline state.
 */
function determineHealthStatus(stage, hasUsefulText, hasAnalysis, chunkCount) {
  if (stage === 'failed') return 'failed';
  // Check for missing / empty content BEFORE 'healthy' — otherwise a
  // file with no extracted text but a stale analysis record gets mis-identified.
  if (stage === 'ready' && !hasUsefulText) return 'empty_extraction';
  if (stage === 'ready' && hasUsefulText && !hasAnalysis) return 'missing_analysis';
  if (stage === 'ready' && hasAnalysis && chunkCount === 0) return 'empty_analysis';
  if (stage === 'ready' && hasAnalysis && chunkCount > 0) return 'healthy';

  // Stuck stages (still processing but > 5 min old)
  const stuckStages = ['uploaded', 'validating', 'extracting', 'chunking', 'embedding', 'indexing'];
  if (stuckStages.includes(stage)) return 'stuck';

  return 'unknown';
}

/**
 * Get a human-readable recommended action based on health status.
 */
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
 *
 * Coordinates the entire repair workflow with logging, tracing, and
 * structured status reporting at each step.
 *
 * @param {object} prisma
 * @param {object} ragService - RAG service instance
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.fileId
 * @returns {Promise<{ok: boolean, result?: object, error?: string, code?: string}>}
 */
async function repairDocument(prisma, ragService, opts = {}) {
  const { userId, fileId } = opts;
  const tracer = getTracer();

  return withSpan(tracer, 'document-context.repairDocument', async (span) => {
    span.setAttribute('file.id', fileId);
    span.setAttribute('user.id', userId);

    // 1. Diagnose current state
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

    // 2. Re-extract text if empty
    if (!hasMeaningfulContent(file.extractedText)) {
      log.info('[document-context] repair: re-extracting text', { fileId, fileName: file.originalName });
      await fileProcessingStatus.setStage(prisma, file.id, 'extracting', { userId });

      const reExtract = await attemptReExtraction(prisma, file, userId, tracer);
      if (!reExtract.ok) {
        span.setStatus({ code: 2, message: 're-extraction failed' });
        return {
          ok: false,
          error: reExtract.extractionError
            ? `Re-extraccion fallo: ${reExtract.extractionError}`
            : 'No se pudo re-extraer el texto del archivo',
          code: 're_extraction_failed',
          diagnostics: { reExtractReason: reExtract.reason },
        };
      }
      file.extractedText = reExtract.text;
    }

    // 3. Re-analyze with retry
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

      // 4. Re-index in RAG (best-effort)
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
          // Non-fatal — analysis succeeded even if RAG indexing didn't
        }
      }

      // 5. Mark as ready
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
 *
 * @param {object} prisma
 * @param {string} userId
 * @returns {Promise<{ok: boolean, result?: object, error?: string}>}
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
      healthy: results.filter((r) => r.stage === 'ready' && !r.error).length,
      stuck: results.filter((r) => r.isStuck).length,
      failed: results.filter((r) => r.stage === 'failed').length,
      processing: results.filter((r) => !r.isStuck && ['uploaded', 'validating', 'extracting', 'chunking', 'embedding', 'indexing'].includes(r.stage)).length,
      missingFromDisk: results.filter((r) => r.stage === 'ready' && !r.fileExistsOnDisk).length,
    };

    span.setAttribute('results.total', summary.total);
    span.setAttribute('results.healthy', summary.healthy);
    span.setAttribute('results.stuck', summary.stuck);
    span.setAttribute('results.failed', summary.failed);
    span.setStatus({ code: 1 });

    return {
      ok: true,
      result: {
        summary,
        files: results,
      },
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
  // Exported for testing
  __test__: {
    backoffDelay,
    isTransientError,
    determineHealthStatus,
    getRecommendedAction,
  },
};
