const express = require('express');
const fsSync = require('fs');
const { authenticateToken } = require('../middleware/auth');
const { parsePositiveInt } = require('../services/chat-scope');
const { softDeleteWhere } = require('../utils/prisma-soft-delete');
const { requireScope } = require('../middleware/require-scope');
const upload = require('../middleware/upload');
const fileProcessingStatus = require('../services/file-processing-status');
const fileProcessor = require('../services/fileProcessor');
const documentRenderer = require('../services/documentRenderer');
const documentIntelligence = require('../services/document-intelligence');
const documentContext = require('../services/agents/document-context');
const documentSummarizer = require('../services/document-summarizer');
const anthropicCitations = require('../services/providers/anthropic-citations');
const queryDecomposer = require('../services/rag/query-decomposer');
const deepAsk = require('../services/rag/deep-ask');
const { validateUploadPolicy } = require('../services/upload-security-policy');
const prisma = require('../config/database');
const rag = require('../services/rag-service');
const ragStore = require('../services/rag-store');
const operationalRag = require('../services/rag/operational-runtime');
const fs = require('fs').promises;
const path = require('path');
const OpenAI = require('openai');
const documentIntentAnalyzer = require('../services/document-intent-analyzer');
const fileIntegrityValidator = require('../services/file-integrity-validator');
const objectStorage = require('../services/object-storage');
const { progressStream } = require('../services/upload-progress-sse');
const {
  MAX_SIMULTANEOUS_DOCUMENTS,
} = require('../config/document-batch-limits');
const {
  contentDispositionHeader,
  safeDownloadFilename,
} = require('../middleware/file-response-safety');

const router = express.Router();

function renderPdfFilename(originalName) {
  const stem = path.basename(String(originalName || 'document'), path.extname(String(originalName || '')));
  return safeDownloadFilename(`${stem}.pdf`, { fallback: 'document.pdf', extension: '.pdf' });
}

// Lazy/safe enforce-org-rate-limit middleware for file uploads. Mirrors
// the wrapper in routes/ai.js: any failure to load or run the underlying
// middleware degrades to a pass-through so a misconfigured Redis store
// or missing prisma model can never block legitimate uploads. The
// middleware itself is also fail-open; this is defence in depth.
let _enforceOrgRateLimitMw = null;
function enforceOrgRateLimitSafe(req, res, next) {
  try {
    if (!_enforceOrgRateLimitMw) {
      // eslint-disable-next-line global-require
      const { enforceOrgRateLimit } = require('../middleware/enforce-org-rate-limit');
      _enforceOrgRateLimitMw = enforceOrgRateLimit();
    }
    return _enforceOrgRateLimitMw(req, res, next);
  } catch (err) {
    try { console.warn('[files/upload] enforce-org-rate-limit load/run failed:', err && err.message); } catch (_) {}
    return next();
  }
}

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// `file-type` v22 is ESM-only; we use a dynamic import wrapped in a
// memoised promise so it loads once per process and works under CJS.
let _fileTypePromise = null;
function loadFileType() {
  if (!_fileTypePromise) _fileTypePromise = import('file-type');
  return _fileTypePromise;
}

function scheduleDefaultRagIndex(userId, fileRecord) {
  const docs = operationalRag.normaliseDocs([fileRecord]);
  if (docs.length === 0) {
    // No document to index; treat the upload as terminal-ready so
    // the file row converges to a non-pending state for the UI to
    // poll. (Images / pure thumbnails land here.)
    fileProcessingStatus.setStage(prisma, fileRecord.id, 'ready', { userId });
    return false;
  }

  setImmediate(async () => {
    // Mark the entry into the async pipeline so the frontend can
    // distinguish "extraction done, still indexing" from "ready".
    await fileProcessingStatus.setStage(prisma, fileRecord.id, 'chunking', { userId });

    // Retry helper: retries RAG indexing up to RAG_INDEX_MAX_RETRIES (default 3)
    // with exponential backoff. Recoverable failures (network, rate-limit,
    // embedding timeouts) are retried; permanent ones skip to failed stage.
    const maxRetries = Number.parseInt(process.env.RAG_INDEX_MAX_RETRIES || '3', 10);
    const baseDelay = Number.parseInt(process.env.RAG_INDEX_RETRY_BASE_MS || '2000', 10);
    let lastError = null;
    let indexed = false;
    let result = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = Math.min(60000, baseDelay * Math.pow(2, attempt - 1)) * (0.5 + Math.random() * 0.5);
        console.warn(`[files] RAG indexing retry ${attempt}/${maxRetries} for file ${fileRecord.id} in ${Math.round(delay)}ms`);
        await new Promise(r => setTimeout(r, delay));
      }
      try {
        await fileProcessingStatus.setStage(prisma, fileRecord.id, 'embedding', { userId });
        result = await operationalRag.ensureIndexed({
          rag,
          userId,
          collection: operationalRag.DEFAULT_COLLECTION,
          docs,
        });
        indexed = true;
        break;
      } catch (err) {
        lastError = err;
        const isRecoverable =
          /rate.?limit|timeout|network|econnrefused|etimedout|5\d\d|429|too many requests/i.test(err?.message || String(err));
        if (!isRecoverable || attempt >= maxRetries) break;
      }
    }

    try {
      if (indexed && result) {
        await fileProcessingStatus.setStage(prisma, fileRecord.id, 'indexing', { userId });
        if (result.indexed && operationalRag.shouldUseGraphBackfill(docs)) {
          const graphSources = (result.ingestedSources && result.ingestedSources.length > 0)
            ? result.ingestedSources
            : docs.map(doc => doc.source);
          operationalRag.scheduleGraphBackfill({
            rag,
            userId,
            collection: operationalRag.DEFAULT_COLLECTION,
            sources: graphSources,
            openai: rag.getOpenAI(),
          });
        }
        await fileProcessingStatus.setStage(prisma, fileRecord.id, 'ready', { userId });

        // Trigger TTL eviction for expired chunks to keep the index clean
        try {
          ragStore.evictExpired(userId, operationalRag.DEFAULT_COLLECTION)
            .then(r => { if (r.removed > 0) console.log(`[files] RAG TTL eviction: removed ${r.removed} expired chunks for user ${userId}`); })
            .catch(() => {});
        } catch (_) { /* best-effort */ }
      } else {
        console.warn('[files] default RAG indexing failed:', lastError?.message || lastError);
        await fileProcessingStatus.setStage(prisma, fileRecord.id, 'failed', {
          userId,
          error: `rag_indexing: ${lastError && lastError.message ? lastError.message : String(lastError)}`,
        });
      }
    } catch (finalErr) {
      console.warn('[files] RAG post-processing failed:', finalErr.message || finalErr);
      await fileProcessingStatus.setStage(prisma, fileRecord.id, 'failed', {
        userId,
        error: `rag_post: ${finalErr && finalErr.message ? finalErr.message : String(finalErr)}`,
      });
    }
  });

  return true;
}

function serializeOcrMeta(result = {}) {
  const ocr = result.ocr || {};
  return {
    ocrStatus: ocr.status || 'skipped',
    ocrConfidence: typeof ocr.confidence === 'number' ? ocr.confidence : null,
    ocrProvider: ocr.provider || null,
  };
}

function serializeAnalysisMeta(analysis = null) {
  if (!analysis) {
    return {
      analysisStatus: 'skipped',
      analysisId: null,
      textCoverage: null,
      pageCount: null,
      sheetCount: null,
      slideCount: null,
      tablesDetected: 0,
    };
  }
  return {
    analysisStatus: analysis.status || 'unknown',
    analysisId: analysis.id || null,
    textCoverage: analysis.textCoverage || null,
    pageCount: analysis.pageCount || null,
    sheetCount: analysis.sheetCount || null,
    slideCount: analysis.slideCount || null,
    tablesDetected: analysis.tableCount || 0,
    analysisSummary: analysis.summary || null,
  };
}

/**
 * Detect a file's true MIME by reading its leading bytes (magic bytes).
 *
 * Why we don't trust `file.mimetype` from multer:
 *   - Browsers often report `application/octet-stream` for clipboard
 *     pastes, drag-from-other-apps, HEIC on Linux, and some ZIP-based
 *     office formats.
 *   - Adversarial uploads can spoof the MIME header (a `.png` rename
 *     of an executable still presents as `image/png` to multer).
 *   - Magic-byte detection is the only reliable source of truth.
 *
 * Returns `{ mime, ext, source }`:
 *   - `source: 'magic-bytes'` — file-type identified the format from
 *     content. Caller MUST re-validate this against the allowlist
 *     because multer's pre-gate only saw the (potentially spoofed)
 *     declared mime/extension.
 *   - `source: 'fallback'` — file-type returned null. This is normal
 *     for plain-text formats (md / csv / json / xml / txt / html) which
 *     have no magic bytes; trust the multer-reported mime.
 *
 * Never throws — detection failure falls back gracefully.
 */
async function detectMime(filePath, fallbackMime) {
  try {
    const { fileTypeFromFile } = await loadFileType();
    const detected = await fileTypeFromFile(filePath);
    if (detected && detected.mime) {
      return { mime: detected.mime, ext: detected.ext || null, source: 'magic-bytes' };
    }
  } catch (e) {
    console.warn('[files] magic-byte detection failed:', e.message);
  }
  return { mime: fallbackMime, ext: null, source: 'fallback' };
}

async function unlinkQuiet(p) {
  try { await fs.unlink(p); } catch (_) { /* already gone */ }
}

// Bound a slow/best-effort step so a hung upstream (OpenAI Files API, a
// parser stuck on a pathological document, etc.) can never consume the
// whole HTTP response budget. The reverse proxy / GCLB cuts a request at
// ~30s regardless of heartbeats, so an un-bounded external call here would
// surface to the user as a *failed upload* even though the binary is
// already safely on disk. We reject fast and let the caller's existing
// try/catch degrade gracefully (text/thumbnail/OpenAI are all optional).
// The underlying promise may keep running in the background; that's fine —
// we only care that the response path is bounded.
function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label || 'operation'} timed out after ${ms}ms`);
      err.code = 'step_timeout';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// Per-step timeout budgets. Kept well under the ~30s proxy cut so the
// synchronous upload path always returns a JSON result, even when an
// upstream is degraded. Overridable via env for ops tuning.
const EXTRACT_TIMEOUT_MS = Number.parseInt(process.env.SIRAGPT_EXTRACT_TIMEOUT_MS || '20000', 10);
const THUMBNAIL_TIMEOUT_MS = Number.parseInt(process.env.SIRAGPT_THUMBNAIL_TIMEOUT_MS || '12000', 10);
const OPENAI_FILE_TIMEOUT_MS = Number.parseInt(process.env.SIRAGPT_OPENAI_FILE_TIMEOUT_MS || '15000', 10);
const ANALYZE_TIMEOUT_MS = Number.parseInt(process.env.SIRAGPT_ANALYZE_TIMEOUT_MS || '8000', 10);

const OPENAI_FILE_MIMES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

// Upload a document to the OpenAI Files API, bounded by a timeout and with
// SDK retries disabled (retries would multiply the wall-clock cost and risk
// the proxy cut). Returns the OpenAI file id, or null on any failure —
// OpenAI Files is an optional enhancement, never a hard upload dependency.
async function uploadToOpenAiFiles(file) {
  if (!OPENAI_FILE_MIMES.has(file.mimetype) && !file.mimetype.startsWith('text/')) {
    return null;
  }
  try {
    const buf = await fs.readFile(file.path);
    const oaFile = await withTimeout(
      openai.files.create(
        { file: new File([buf], file.originalname, { type: file.mimetype }), purpose: 'assistants' },
        { timeout: OPENAI_FILE_TIMEOUT_MS, maxRetries: 0 },
      ),
      OPENAI_FILE_TIMEOUT_MS + 2000,
      'OpenAI Files upload',
    );
    return oaFile.id;
  } catch (openaiError) {
    console.error('OpenAI file upload error:', openaiError?.message || openaiError);
    return null;
  }
}


// ─── Parallel batch processor ──────────────────────────────────────────────
// Processes files in chunks of MAX_CONCURRENT to avoid overwhelming the
// event loop, DB connection pool, and upstream API rate limits.
const MAX_CONCURRENT = Number.parseInt(process.env.SIRAGPT_UPLOAD_CONCURRENCY || '5', 10);

/**
 * Process files in parallel batches. Each batch goes through:
 * DB record → validate → extract → thumbnail → OpenAI Files → RAG schedule.
 * Returns results in the same order as the input files array.
 * Controlled concurrency prevents overloading event loop and API rate limits.
 */
async function processFilesInParallel(files, userId, prismaClient) {
  const results = new Array(files.length).fill(null);

  for (let i = 0; i < files.length; i += MAX_CONCURRENT) {
    const batch = files.slice(i, i + MAX_CONCURRENT);
    const batchPromises = batch.map(async (file) => {
      let fileRecord = null;
      try {
        fileRecord = await prismaClient.file.create({
          data: {
            userId,
            filename: file.filename,
            originalName: file.originalname,
            mimeType: file.mimetype,
            size: file.size,
            path: file.path,
            extractedText: null,
            openaiFileId: null,
            processingStage: 'uploaded',
            processingStageAt: new Date(),
          },
        });
      } catch (createError) {
        console.error('[files] could not create File row:', createError.message || createError);
        await unlinkQuiet(file.path);
        return {
          name: file.originalname, size: file.size, type: file.mimetype,
          success: false, error: 'No se pudo registrar el archivo en la base de datos.',
          code: 'db_create_failed',
        };
      }

      try {
        // ── Validate (magic bytes) ──
        await fileProcessingStatus.setStage(prismaClient, fileRecord.id, 'validating', { userId });
        const detection = await detectMime(file.path, file.mimetype);
        const policy = validateUploadPolicy({
          originalName: file.originalname,
          declaredMime: file.mimetype,
          detectedMime: detection.mime,
          detectionSource: detection.source,
          size: file.size,
        });
        if (!policy.ok) {
          console.warn(`[files] rejected ${file.originalname}: declared=${file.mimetype} real=${detection.mime || 'unknown'} reason=${policy.code}`);
          await fileProcessingStatus.setStage(prismaClient, fileRecord.id, 'failed', { userId, error: `${policy.code}: ${policy.message}` });
          await unlinkQuiet(file.path);
          return { id: fileRecord.id, name: file.originalname, size: file.size, type: file.mimetype, success: false, error: policy.message, code: policy.code, detectedMime: detection.mime || null, detectedExtension: detection.ext || null };
        }
        if (policy.mimeType && policy.mimeType !== file.mimetype) {
          file.mimetype = policy.mimeType;
        }

        // ── File integrity validation ──
        // Quick structural checks to catch corrupted/truncated files
        // before we invest time in expensive extraction.
        let integrity = { valid: true, warnings: [], issues: [] };
        try {
          integrity = await fileIntegrityValidator.validateFile(file.path, file.mimetype, file.size);
          if (!integrity.valid && integrity.issues.some(iss => iss.code === 'empty_file')) {
            await fileProcessingStatus.setStage(prismaClient, fileRecord.id, 'failed', { userId, error: 'empty_file: El archivo esta vacio (0 bytes).' });
            await unlinkQuiet(file.path);
            return { id: fileRecord.id, name: file.originalname, size: file.size, type: file.mimetype, success: false, error: 'El archivo esta vacio.', code: 'empty_file' };
          }
          if (integrity.issues.length > 0) {
            console.warn(`[files] integrity warnings for ${file.originalname}:`, integrity.issues.map(i => i.message).join('; '));
          }
        } catch { /* integrity validation is best-effort */ }

        // ── Extract text (BEST-EFFORT) ──
        // A parser failure must NEVER fail the upload. The binary is already
        // stored and usable (preview/download + OpenAI Files API), so a docx/
        // pdf/etc. that trips the extractor still uploads successfully — it
        // just lands with no locally-extracted text. This is the core of the
        // "any document uploads without failure" guarantee.
        await fileProcessingStatus.setStage(prismaClient, fileRecord.id, 'extracting', { userId });

        // Run extraction, thumbnail, and the OpenAI Files upload CONCURRENTLY.
        // They're independent (all read only the on-disk binary), so racing
        // them keeps the worst-case wall-clock at max(step), not the sum —
        // critical because the reverse proxy cuts the response at ~30s. Each
        // is individually bounded and degrades to a safe default on failure,
        // so a slow/down upstream never fails the upload.
        const [result, thumbnailPath, openaiFileId] = await Promise.all([
          withTimeout(fileProcessor.processFile(file), EXTRACT_TIMEOUT_MS, `text extraction (${file.originalname})`)
            .catch((extractErr) => {
              console.warn(`[files] text extraction failed for ${file.originalname} — upload still succeeds:`, extractErr?.message || extractErr);
              return { success: false, extractedText: '', error: `extraction_degraded: ${extractErr?.message || extractErr}` };
            }),
          withTimeout(fileProcessor.generateThumbnail(file.path, file.mimetype), THUMBNAIL_TIMEOUT_MS, `thumbnail (${file.originalname})`)
            .catch((thumbErr) => {
              console.warn(`[files] thumbnail generation failed for ${file.originalname}:`, thumbErr?.message || thumbErr);
              return null;
            }),
          uploadToOpenAiFiles(file),
        ]);

        // ── Update DB record ──
        fileRecord = await prismaClient.file.update({
          where: { id: fileRecord.id },
          data: { mimeType: file.mimetype, extractedText: result.extractedText, openaiFileId },
        });

        const ragQueued = scheduleDefaultRagIndex(userId, fileRecord);
        const ocrMeta = serializeOcrMeta(result);
        let analysis = null;
        try {
          analysis = await withTimeout(
            documentIntelligence.analyzeFile(prismaClient, { userId, fileRecord, extractionResult: result, force: true }),
            ANALYZE_TIMEOUT_MS,
            `document analysis (${file.originalname})`,
          );
        } catch (analysisError) { console.warn('[files] document analysis failed:', analysisError.message || analysisError); }

        // Offload the binary (+ thumbnail) to R2 AFTER extraction and analysis,
        // which may re-read the local file. Keeps nothing durable on the VM.
        try {
          const { ref: storedRef } = await persistUploadBinary({ file, userId, thumbnailPath });
          if (storedRef && storedRef !== file.path) {
            fileRecord = await prismaClient.file.update({ where: { id: fileRecord.id }, data: { path: storedRef } });
          }
        } catch (offloadErr) { console.warn('[files] R2 offload step failed:', offloadErr?.message || offloadErr); }

        // The upload itself succeeded (binary stored + record updated), so we
        // always report success. A degraded extraction is surfaced as a soft
        // `extractionWarning`, not a hard `error`, so the attachment stays
        // usable instead of being shown as a failed upload.
        const extractionDegraded = result.success === false;
        return { id: fileRecord.id, name: file.originalname, size: file.size, type: file.mimetype, url: `/uploads/${userId}/${file.filename}`, thumbnailUrl: thumbnailPath ? `/uploads/${userId}/${path.basename(thumbnailPath)}` : null, extractedText: result.extractedText, ...ocrMeta, ...serializeAnalysisMeta(analysis), openaiFileId, ragIndexed: ragQueued ? 'queued' : 'skipped', success: true, error: null, extractionWarning: extractionDegraded ? (result.error || 'extraction_degraded') : null };
      } catch (error) {
        console.error('File processing error:', error);
        if (fileRecord?.id) { await fileProcessingStatus.setStage(prismaClient, fileRecord.id, 'failed', { userId, error: `processing: ${error?.message || error}` }); }
        return { id: fileRecord?.id, name: file.originalname, size: file.size, type: file.mimetype, success: false, ocrStatus: 'failed', ocrConfidence: 0, ocrProvider: null, error: error.message };
      }
    });
    const batchResults = await Promise.all(batchPromises);
    for (let j = 0; j < batchResults.length; j++) results[i + j] = batchResults[j];
  }
  return results;
}

// Move an uploaded binary (and optional thumbnail) off the VM into R2 so
// nothing durable lives on local disk. The R2 key MIRRORS the public
// "/uploads/<userId>/<filename>" path, so the response URL stays the same and
// is served by the R2 fallback middleware. Returns the storage ref to persist
// in File.path. When R2 is disabled (dev) this is a no-op and returns the local
// path, preserving legacy local-disk behaviour. Best-effort: on any R2 error we
// fall back to the local path so an upload never fails because of offload.
async function persistUploadBinary({ file, userId, thumbnailPath }) {
  if (!objectStorage.enabled()) return { ref: file.path, thumbRef: thumbnailPath || null };
  let ref = file.path;
  let thumbRef = thumbnailPath || null;
  try {
    const up = await objectStorage.persistLocalFile({
      localPath: file.path,
      key: objectStorage.uploadKey(userId, file.filename),
      contentType: file.mimetype,
    });
    ref = up.ref;
  } catch (err) {
    console.warn(`[files] R2 offload failed for ${file.originalname}, keeping local: ${err?.message || err}`);
    return { ref: file.path, thumbRef };
  }
  if (thumbnailPath) {
    try {
      const th = await objectStorage.persistLocalFile({
        localPath: thumbnailPath,
        key: objectStorage.uploadKey(userId, path.basename(thumbnailPath)),
        contentType: 'image/jpeg',
      });
      thumbRef = th.ref;
    } catch (err) {
      console.warn(`[files] R2 thumbnail offload failed: ${err?.message || err}`);
    }
  }
  return { ref, thumbRef };
}

function isAsyncUploadRequest(req) {
  const value = req.body && req.body.asyncProcessing;
  return value === true || /^(1|true|yes)$/i.test(String(value || ''));
}

function uploadResponseForFile(file, fileRecord, extra = {}) {
  return {
    id: fileRecord.id,
    name: file.originalname,
    originalName: file.originalname,
    filename: file.filename,
    size: file.size,
    type: file.mimetype,
    mimeType: file.mimetype,
    url: `/uploads/${fileRecord.userId}/${file.filename}`,
    thumbnailUrl: null,
    extractedText: null,
    processingStage: extra.processingStage || 'extracting',
    status: extra.status || 'uploaded',
    ragIndexed: extra.ragIndexed || 'pending',
    success: true,
    error: null,
  };
}

async function processFileAfterFastUpload(file, userId, prismaClient, fileRecord) {
  try {
    let integrity = { valid: true, warnings: [], issues: [] };
    try {
      integrity = await fileIntegrityValidator.validateFile(file.path, file.mimetype, file.size);
      if (!integrity.valid && integrity.issues.some(iss => iss.code === 'empty_file')) {
        await fileProcessingStatus.setStage(prismaClient, fileRecord.id, 'failed', { userId, error: 'empty_file: El archivo esta vacio (0 bytes).' });
        await unlinkQuiet(file.path);
        return;
      }
      if (integrity.issues.length > 0) {
        console.warn(`[files] integrity warnings for ${file.originalname}:`, integrity.issues.map(i => i.message).join('; '));
      }
    } catch { /* integrity validation is best-effort */ }

    await fileProcessingStatus.setStage(prismaClient, fileRecord.id, 'extracting', { userId });
    // Best-effort extraction: a parser failure must not flip the file to
    // "failed" — it stays uploaded and usable (preview + OpenAI Files API),
    // just without locally-extracted text.
    let result;
    try {
      result = await withTimeout(fileProcessor.processFile(file), EXTRACT_TIMEOUT_MS, `text extraction (${file.originalname})`);
    } catch (extractErr) {
      console.warn(`[files] async text extraction failed for ${file.originalname} — file stays usable:`, extractErr?.message || extractErr);
      result = { success: false, extractedText: '', error: `extraction_degraded: ${extractErr?.message || extractErr}` };
    }
    let thumbnailPath = null;
    try {
      thumbnailPath = await withTimeout(fileProcessor.generateThumbnail(file.path, file.mimetype), THUMBNAIL_TIMEOUT_MS, `thumbnail (${file.originalname})`);
    } catch (thumbErr) {
      console.warn(`[files] async thumbnail generation failed for ${file.originalname}:`, thumbErr?.message || thumbErr);
    }

    const openaiFileId = await uploadToOpenAiFiles(file);

    fileRecord = await prismaClient.file.update({
      where: { id: fileRecord.id },
      data: { mimeType: file.mimetype, extractedText: result.extractedText, openaiFileId },
    });

    scheduleDefaultRagIndex(userId, fileRecord);
    try {
      await documentIntelligence.analyzeFile(prismaClient, { userId, fileRecord, extractionResult: result, force: true });
    } catch (analysisError) { console.warn('[files] document analysis failed:', analysisError.message || analysisError); }

    // Offload binary (+ thumbnail) to R2 after extraction + analysis.
    try {
      const { ref: storedRef } = await persistUploadBinary({ file, userId, thumbnailPath });
      if (storedRef && storedRef !== file.path) {
        fileRecord = await prismaClient.file.update({ where: { id: fileRecord.id }, data: { path: storedRef } });
      }
    } catch (offloadErr) { console.warn('[files] R2 offload step failed:', offloadErr?.message || offloadErr); }

    if (thumbnailPath) {
      // Thumbnail is stored on disk for later consumers; no extra DB field exists
      // on File, so the immediate upload response remains the source of truth.
    }
  } catch (error) {
    console.error('File processing error:', error);
    if (fileRecord?.id) {
      await fileProcessingStatus.setStage(prismaClient, fileRecord.id, 'failed', { userId, error: `processing: ${error?.message || error}` });
    }
  }
}

function scheduleFileAfterFastUpload(file, userId, prismaClient, fileRecord) {
  setImmediate(() => {
    processFileAfterFastUpload(file, userId, prismaClient, fileRecord)
      .catch(err => console.warn('[files] async post-upload processing failed:', err?.message || err));
  });
}

async function processFilesForAsyncPreview(files, userId, prismaClient) {
  const results = new Array(files.length).fill(null);

  for (let i = 0; i < files.length; i += MAX_CONCURRENT) {
    const batch = files.slice(i, i + MAX_CONCURRENT);
    const batchPromises = batch.map(async (file) => {
      let fileRecord = null;
      try {
        fileRecord = await prismaClient.file.create({
          data: {
            userId,
            filename: file.filename,
            originalName: file.originalname,
            mimeType: file.mimetype,
            size: file.size,
            path: file.path,
            extractedText: null,
            openaiFileId: null,
            processingStage: 'uploaded',
            processingStageAt: new Date(),
          },
        });
      } catch (createError) {
        console.error('[files] could not create File row:', createError.message || createError);
        await unlinkQuiet(file.path);
        return {
          name: file.originalname, size: file.size, type: file.mimetype,
          success: false, error: 'No se pudo registrar el archivo en la base de datos.',
          code: 'db_create_failed',
        };
      }

      try {
        await fileProcessingStatus.setStage(prismaClient, fileRecord.id, 'validating', { userId });
        const detection = await detectMime(file.path, file.mimetype);
        const policy = validateUploadPolicy({
          originalName: file.originalname,
          declaredMime: file.mimetype,
          detectedMime: detection.mime,
          detectionSource: detection.source,
          size: file.size,
        });
        if (!policy.ok) {
          console.warn(`[files] rejected ${file.originalname}: declared=${file.mimetype} real=${detection.mime || 'unknown'} reason=${policy.code}`);
          await fileProcessingStatus.setStage(prismaClient, fileRecord.id, 'failed', { userId, error: `${policy.code}: ${policy.message}` });
          await unlinkQuiet(file.path);
          return { id: fileRecord.id, name: file.originalname, size: file.size, type: file.mimetype, mimeType: file.mimetype, success: false, error: policy.message, code: policy.code, detectedMime: detection.mime || null, detectedExtension: detection.ext || null };
        }
        if (policy.mimeType && policy.mimeType !== file.mimetype) {
          file.mimetype = policy.mimeType;
          fileRecord = await prismaClient.file.update({
            where: { id: fileRecord.id },
            data: { mimeType: file.mimetype },
          });
        }

        await fileProcessingStatus.setStage(prismaClient, fileRecord.id, 'extracting', { userId });
        scheduleFileAfterFastUpload(file, userId, prismaClient, fileRecord);
        return uploadResponseForFile(file, fileRecord);
      } catch (error) {
        console.error('Fast upload validation error:', error);
        if (fileRecord?.id) {
          await fileProcessingStatus.setStage(prismaClient, fileRecord.id, 'failed', { userId, error: `processing: ${error?.message || error}` });
        }
        await unlinkQuiet(file.path);
        return { id: fileRecord?.id, name: file.originalname, size: file.size, type: file.mimetype, mimeType: file.mimetype, success: false, error: error.message };
      }
    });
    const batchResults = await Promise.all(batchPromises);
    for (let j = 0; j < batchResults.length; j++) results[i + j] = batchResults[j];
  }

  return results;
}

function scheduleCrossDocumentAnalysisWhenReady(fileIds, userId) {
  const ids = Array.from(new Set((fileIds || []).map(String).filter(Boolean))).slice(0, MAX_SIMULTANEOUS_DOCUMENTS);
  if (ids.length < 2) return;

  setImmediate(async () => {
    const deadline = Date.now() + Number.parseInt(process.env.SIRAGPT_BATCH_CONTEXT_WAIT_MS || '60000', 10);
    let records = [];
    while (Date.now() < deadline) {
      records = await prisma.file.findMany({
        where: { id: { in: ids }, userId },
        select: { id: true, originalName: true, extractedText: true, mimeType: true, size: true },
      }).catch(() => []);
      if (records.filter(r => r.extractedText && r.extractedText.length > 200).length >= 2) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    const readyFiles = records
      .filter(r => r.extractedText && r.extractedText.length > 200)
      .map(r => ({
        id: r.id,
        name: r.originalName,
        extractedText: r.extractedText,
        type: r.mimeType,
        mimeType: r.mimeType,
        size: r.size,
        success: true,
      }));
    if (readyFiles.length >= 2) {
      scheduleCrossDocumentAnalysis(readyFiles, userId).catch(err =>
        console.warn('[files] async cross-document analysis error:', err.message || err)
      );
    }
  });
}

// Upload files — parallel batch processing
router.post('/upload', authenticateToken, requireScope('files:write'), upload.array('files', MAX_SIMULTANEOUS_DOCUMENTS), enforceOrgRateLimitSafe, async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const asyncProcessing = isAsyncUploadRequest(req);
    const processedFiles = asyncProcessing
      ? await processFilesForAsyncPreview(req.files, req.user.id, prisma)
      : await processFilesInParallel(req.files, req.user.id, prisma);

    // ── Cross-document context for batch uploads ──
    // When multiple files are uploaded together, build a cross-document
    // context that correlates content. This helps the chat infer intent.
    if (asyncProcessing) {
      scheduleCrossDocumentAnalysisWhenReady(
        processedFiles.filter(f => f.success && f.id).map(f => f.id),
        req.user.id,
      );
    } else {
      const successFiles = processedFiles.filter(f => f.success && f.id && f.extractedText && f.extractedText.length > 200);
      if (successFiles.length >= 2) {
        scheduleCrossDocumentAnalysis(processedFiles, req.user.id).catch(err =>
          console.warn('[files] cross-document analysis error:', err.message || err)
        );
      }
    }

    const ok = processedFiles.filter(f => f.success).length;
    res.json({
      message: ok === req.files.length
        ? 'Files processed successfully'
        : `${ok} of ${req.files.length} files processed`,
      files: processedFiles,
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'File upload failed' });
  }
});

/**
 * Schedule async cross-document analysis using the document-intent-analyzer.
 * Correlates content across uploaded files, infers user intent, and stores
 * structured analysis for the chat to reference later.
 */
function scheduleCrossDocumentAnalysis(processedFiles, userId) {
  return new Promise(resolve => {
    setImmediate(async () => {
      try {
        const fileIds = processedFiles.filter(f => f.success && f.id && f.extractedText?.length > 200).map(f => f.id);
        if (fileIds.length < 2) { resolve(); return; }

        const records = await prisma.file.findMany({
          where: { id: { in: fileIds }, userId },
          select: { id: true, originalName: true, extractedText: true, mimeType: true, size: true },
        });

        if (records.length < 2) { resolve(); return; }

        // Convert to the format document-intent-analyzer expects
        const docs = records.map(r => ({
          id: r.id,
          name: r.originalName,
          text: r.extractedText || '',
          mimeType: r.mimeType,
          size: r.size,
        }));

        // Run intent analysis on the batch (heuristic-only, no LLM)
        const intentResult = await documentIntentAnalyzer.analyzeBatch(docs);

        // Also store a lightweight preview map for quick chat reference
        // (keyed by userId + latest)
        if (!global.__siraBatchContext) global.__siraBatchContext = new Map();
        const batchKey = 'batch:' + userId + ':' + Date.now();
        global.__siraBatchContext.set(batchKey, {
          userId,
          createdAt: new Date().toISOString(),
          fileCount: records.length,
          primaryIntent: intentResult.primaryIntent,
          crossDocSummary: intentResult.crossDocSummary,
          totalChars: docs.reduce((s, d) => s + d.text.length, 0),
          files: records.map(r => ({
            id: r.id, name: r.originalName, type: r.mimeType,
            size: r.size,
            chars: (r.extractedText || '').length,
            preview: (r.extractedText || '').slice(0, 2000),
          })),
        });

        // Cap store at 20 entries
        if (global.__siraBatchContext.size > 20) {
          const keys = [...global.__siraBatchContext.keys()];
          keys.slice(0, keys.length - 20).forEach(k => global.__siraBatchContext.delete(k));
        }

        console.log('[files] intent analysis for ' + records.length + ' files: ' +
          intentResult.primaryIntent + ' (batchId=' + intentResult.batchId + ')');
      } catch (err) {
        console.warn('[files] cross-document analysis failed:', err.message || err);
      }
      resolve();
    });
  });
}

/**
 * GET /api/files/:id/processing-status
 *
 * Lightweight polling endpoint the chat UI hits while an attachment
 * is in flight. Returns the current stage of the file's processing
 * state machine, plus the timestamp of the last transition and the
 * failure reason when stage='failed'. The frontend uses this to:
 *   - swap the chip badge from "Procesando" → "Listo"
 *   - show "Error: <reason>" inline instead of a silent spinner
 *   - stop polling once isTerminal=true
 *
 * Authorisation: a user can only read status for their own files.
 */
router.get('/:id/processing-status', authenticateToken, async (req, res) => {
  try {
    const status = await fileProcessingStatus.getStatus(prisma, req.params.id);
    if (!status) return res.status(404).json({ error: 'File not found' });
    if (status.userId !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    return res.json({
      fileId: status.fileId,
      name: status.name,
      mimeType: status.mimeType,
      size: status.size,
      stage: status.stage,
      error: status.error,
      stageAt: status.stageAt,
      isTerminal: status.isTerminal,
      createdAt: status.createdAt,
    });
  } catch (err) {
    console.error('[files] processing-status read failed:', err.message || err);
    return res.status(500).json({ error: 'Failed to read processing status' });
  }
});

/**
 * GET /api/files/progress-stream?fileIds=id1,id2,id3
 *
 * Real-time SSE stream for file processing progress.
 * Clients connect once and receive events as each file moves
 * through the processing pipeline (uploaded → validating →
 * extracting → chunking → embedding → indexing → ready).
 *
 * Events: stage, complete, error, heartbeat, done, timeout
 *
 * Authorization: user can only stream progress for their own files.
 */
router.get('/progress-stream', authenticateToken, async (req, res) => {
  progressStream(req, res);
});

// Get user files
router.get('/', authenticateToken, async (req, res) => {
  try {
    // Clamp pagination: bare parseInt(NaN)/negatives would crash Prisma's
    // take/skip (500 on 400-class input) and an unbounded limit could pull the
    // whole table.
    const page = parsePositiveInt(req.query.page, 1, { min: 1, max: 100000 });
    const limit = parsePositiveInt(req.query.limit, 20, { min: 1, max: 100 });
    const { type } = req.query;
    const skip = (page - 1) * limit;

    const where = softDeleteWhere({
      userId: req.user.id,
      ...(type && { mimeType: { startsWith: type } })
    });

    const [files, total] = await Promise.all([
      prisma.file.findMany({
        where,
        select: {
          id: true,
          filename: true,
          originalName: true,
          mimeType: true,
          size: true,
          createdAt: true
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' }
      }),
      prisma.file.count({ where })
    ]);

    const filesWithUrls = files.map(file => ({
      ...file,
      url: `/uploads/${req.user.id}/${file.filename}`
    }));

    res.json({
      files: filesWithUrls,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Get files error:', error);
    res.status(500).json({ error: 'Failed to fetch files' });
  }
});

// Get structured document analysis
router.get('/:id/analysis', authenticateToken, async (req, res) => {
  try {
    const file = await prisma.file.findFirst({
      where: { id: req.params.id, userId: req.user.id },
      select: { id: true },
    });
    if (!file) return res.status(404).json({ error: 'File not found' });

    let analysis = await documentIntelligence.getAnalysisForFile(prisma, {
      userId: req.user.id,
      fileId: file.id,
    });
    if (!analysis) {
      analysis = await documentIntelligence.analyzeFile(prisma, {
        userId: req.user.id,
        fileId: file.id,
      });
    }
    res.json({ analysis });
  } catch (error) {
    console.error('Get analysis error:', error);
    res.status(500).json({ error: 'Failed to fetch file analysis', detail: error.message });
  }
});

// Force structured document analysis refresh
router.post('/:id/analyze', authenticateToken, async (req, res) => {
  try {
    const analysis = await documentIntelligence.analyzeFile(prisma, {
      userId: req.user.id,
      fileId: req.params.id,
      force: true,
    });
    res.json({ analysis });
  } catch (error) {
    const status = /not found/i.test(error.message) ? 404 : 500;
    console.error('Analyze file error:', error);
    res.status(status).json({ error: 'Failed to analyze file', detail: error.message });
  }
});

// Retrieve grounded evidence chunks for a document
router.get('/:id/evidence', authenticateToken, async (req, res) => {
  try {
    const file = await prisma.file.findFirst({
      where: { id: req.params.id, userId: req.user.id },
      select: { id: true },
    });
    if (!file) return res.status(404).json({ error: 'File not found' });

    let analysis = await documentIntelligence.getAnalysisForFile(prisma, {
      userId: req.user.id,
      fileId: file.id,
    });
    if (!analysis) {
      analysis = await documentIntelligence.analyzeFile(prisma, {
        userId: req.user.id,
        fileId: file.id,
      });
    }

    const result = await documentIntelligence.retrieveEvidence(prisma, {
      userId: req.user.id,
      fileId: file.id,
      query: req.query.query || '',
      limit: req.query.limit || 8,
    });
    res.json({
      analysis: result.analysis || analysis,
      evidence: result.evidence,
    });
  } catch (error) {
    console.error('Get evidence error:', error);
    res.status(500).json({ error: 'Failed to fetch document evidence', detail: error.message });
  }
});

// Get normalized tables for a document
router.get('/:id/tables', authenticateToken, async (req, res) => {
  try {
    const file = await prisma.file.findFirst({
      where: { id: req.params.id, userId: req.user.id },
      select: { id: true },
    });
    if (!file) return res.status(404).json({ error: 'File not found' });

    let tables = await documentIntelligence.getTablesForFile(prisma, {
      userId: req.user.id,
      fileId: file.id,
    });
    if (!tables.length) {
      await documentIntelligence.analyzeFile(prisma, {
        userId: req.user.id,
        fileId: file.id,
      });
      tables = await documentIntelligence.getTablesForFile(prisma, {
        userId: req.user.id,
        fileId: file.id,
      });
    }
    res.json({ tables });
  } catch (error) {
    console.error('Get tables error:', error);
    res.status(500).json({ error: 'Failed to fetch document tables', detail: error.message });
  }
});

// Get file details
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const file = await prisma.file.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id
      }
    });

    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    res.json({
      ...file,
      url: `/uploads/${req.user.id}/${file.filename}`
    });
  } catch (error) {
    console.error('Get file error:', error);
    res.status(500).json({ error: 'Failed to fetch file' });
  }
});

// Get file content
router.get('/:id/content', authenticateToken, async (req, res) => {
  try {
    const file = await prisma.file.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id
      }
    });

    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    // For now, we'll just send back the extracted text.
    // In the future, you might want to read the file from file.path
    // if the content is not stored in the database.
    res.send(file.extractedText || 'No content available.');

  } catch (error) {
    console.error('Get file content error:', error);
    res.status(500).json({ error: 'Failed to fetch file content' });
  }
});

// Render a non-web-native document (PPTX, DOC, RTF, ODP, …) to PDF for
// high-fidelity preview in the unified viewer. Conversion runs through
// the documentRenderer service (LibreOffice or Gotenberg) and the
// resulting PDF is cached on disk by file id, so a second request is a
// pure file read. Auth-protected; returns the PDF inline.
router.get('/:id/render', authenticateToken, async (req, res) => {
  try {
    const target = (req.query.target || 'pdf').toString().toLowerCase();
    if (target !== 'pdf') {
      return res.status(400).json({ error: `Unsupported render target: ${target}` });
    }

    const file = await prisma.file.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!file) return res.status(404).json({ error: 'File not found' });

    const isPdf = file.mimeType === 'application/pdf' || /\.pdf$/i.test(file.originalName || '');
    if (isPdf) {
      if (!(await objectStorage.exists(file.path))) {
        return res.status(404).json({ error: 'File not found' });
      }
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', contentDispositionHeader('inline', renderPdfFilename(file.originalName)));
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.setHeader('X-Render-Engine', 'native-pdf');
      res.setHeader('X-Render-From-Cache', 'true');
      const { stream } = await objectStorage.readStream(file.path);
      return stream.pipe(res);
    }

    if (!documentRenderer.isConvertible(file.mimeType, file.originalName)) {
      return res.status(415).json({
        error: 'Format not convertible',
        mimeType: file.mimeType,
      });
    }

    let pdfPath;
    // The renderer (LibreOffice/Gotenberg) needs a real filesystem path. When
    // the source binary lives in R2, materialize it to a temp file first and
    // clean it up once conversion is done.
    let materialized = null;
    try {
      materialized = await objectStorage.toLocalTemp(file.path);
      const out = await documentRenderer.renderToPdf({
        id: file.id,
        path: materialized.path,
        mimeType: file.mimeType,
        originalName: file.originalName,
      });
      pdfPath = out.pdfPath;
      res.setHeader('X-Render-Engine', out.engine);
      res.setHeader('X-Render-From-Cache', String(out.fromCache));
    } catch (err) {
      if (err instanceof documentRenderer.RendererUnavailableError) {
        return res.status(503).json({ error: err.message, code: err.code });
      }
      if (err instanceof documentRenderer.RendererUnsupportedError) {
        return res.status(415).json({ error: err.message, code: err.code });
      }
      console.error('[files] render failed:', err);
      return res.status(500).json({ error: 'Render failed', detail: err.message });
    } finally {
      if (materialized) { try { await materialized.cleanup(); } catch { /* best-effort */ } }
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDispositionHeader('inline', renderPdfFilename(file.originalName)));
    res.setHeader('Cache-Control', 'private, max-age=86400');
    fsSync.createReadStream(pdfPath).pipe(res);
  } catch (error) {
    console.error('Render route error:', error);
    res.status(500).json({ error: 'Failed to render document' });
  }
});

// Delete file
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const file = await prisma.file.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id
      }
    });

    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Delete the binary from durable storage (R2 ref or local path).
    try {
      await objectStorage.remove(file.path);
      // Also try to delete thumbnail if it exists
      const thumbnailPath = file.path + '_thumb.jpg';
      try {
        await fs.unlink(thumbnailPath);
      } catch (e) {
        // Ignore thumbnail deletion errors
      }
      // Clear cached PDF render (if any). Best-effort; never blocks.
      const renderedPdf = path.join(process.env.UPLOAD_DIR || 'uploads', '_rendered', `${file.id}.pdf`);
      try { await fs.unlink(renderedPdf); } catch (e) { /* not present */ }
    } catch (error) {
      console.error('File deletion error:', error);
    }

    // Delete from database
    await prisma.file.delete({
      where: { id: req.params.id }
    });

    res.json({ message: 'File deleted successfully' });
  } catch (error) {
    console.error('Delete file error:', error);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

// ── Document diagnostics and repair endpoints ────────────────────
// Built on the robust document-context service, these routes let the
// frontend check document health, retry failed analyses, and repair
// stuck pipeline states without a full re-upload.

/**
 * GET /api/files/:id/diagnose
 *
 * Full diagnostic of a file's document analysis pipeline: processing
 * stage, extracted text quality, analysis DB records, chunk/table
 * counts, and a recommended action when something is wrong.
 *
 * Response includes `canRepair` (boolean) and `recommendedAction`
 * (human-readable string) when the file needs attention.
 */
router.get('/:id/diagnose', authenticateToken, async (req, res) => {
  try {
    const result = await documentContext.diagnoseFile(prisma, {
      userId: req.user.id,
      fileId: req.params.id,
    });
    if (!result.ok) {
      const status = result.code === 'file_not_found' ? 404 : 422;
      return res.status(status).json({ error: result.error, code: result.code });
    }
    return res.json({
      file: result.result.diagnostics,
      canRepair: result.result.canRepair,
      recommendedAction: result.result.recommendedAction,
    });
  } catch (err) {
    console.error('[files] diagnose error:', err.message || err);
    return res.status(500).json({ error: 'Failed to diagnose document', detail: err.message });
  }
});

/**
 * POST /api/files/:id/repair
 *
 * Full repair pipeline for a document: re-extracts text (if empty),
 * re-runs document intelligence analysis with retry, and re-indexes
 * in the RAG vector store. Logs every step and returns the new
 * analysis result.
 *
 * Safe to call on healthy documents (no-op on the analysis side;
 * just returns current state).
 */
router.post('/:id/repair', authenticateToken, async (req, res) => {
  try {
    const result = await documentContext.repairDocument(prisma, rag, {
      userId: req.user.id,
      fileId: req.params.id,
    });
    if (!result.ok) {
      const status = result.code === 'file_not_found' ? 404 : 500;
      return res.status(status).json({
        error: result.error,
        code: result.code,
        diagnostics: result.diagnostics || null,
      });
    }
    return res.json({
      message: 'Documento reparado correctamente',
      fileName: result.result.fileName,
      analysis: result.result.analysis,
      previousDiagnostics: result.result.diagnostics,
    });
  } catch (err) {
    console.error('[files] repair error:', err.message || err);
    return res.status(500).json({ error: 'Failed to repair document', detail: err.message });
  }
});

/**
 * GET /api/files/diagnostics/batch
 *
 * Batch diagnostic scan of all the user's files. Returns aggregate
 * summary (healthy / stuck / failed / processing counts) plus a
 * per-file breakdown with stage, error, age, and disk presence.
 *
 * The frontend can use this to show a document health dashboard
 * or automatically prompt the user to repair stale files.
 */
router.get('/diagnostics/batch', authenticateToken, async (req, res) => {
  try {
    const result = await documentContext.batchDiagnose(prisma, req.user.id);
    if (!result.ok) {
      return res.status(500).json({ error: result.error, code: result.code });
    }
    return res.json({
      summary: result.result.summary,
      files: result.result.files,
    });
  } catch (err) {
    console.error('[files] batch diagnostics error:', err.message || err);
    return res.status(500).json({ error: 'Failed to scan documents', detail: err.message });
  }
});

/**
 * GET /api/files/:id/summary — on-demand structured LLM analysis of a
 * single file the caller owns.
 *
 * Pipeline:
 *   1. Verify ownership via the userId from the JWT.
 *   2. Hit the cache in DocumentAnalysis.metadata.llmSummary unless
 *      ?refresh=true.
 *   3. On miss, call summarizeDocumentStructured and persist the
 *      result back into metadata for the next reader.
 *
 * Why on-demand instead of post-upload: most uploaded files are never
 * opened in the analysis view. Running the LLM pass on every upload
 * burns tokens for documents the user never reads. Computing on first
 * request keeps token spend proportional to actual interest.
 *
 * Errors:
 *   404  doc_summarizer_file_not_found     wrong fileId / wrong owner
 *   422  doc_summarizer_empty_text         extraction yielded no text
 *   502  doc_summarizer_llm_failed         upstream OpenAI failure
 *   502  doc_summarizer_invalid_json       model returned non-JSON
 */
router.get('/:id/summary', authenticateToken, async (req, res) => {
  try {
    const refresh = String(req.query?.refresh || '').toLowerCase() === 'true';
    const result = await documentSummarizer.getOrComputeFileSummary({
      prisma,
      openai,
      userId: req.user.id,
      fileId: req.params.id,
      refresh,
    });
    return res.json({
      fileId: req.params.id,
      fromCache: result.fromCache,
      summary: result.summary,
    });
  } catch (err) {
    const code = err && err.code ? err.code : 'doc_summarizer_unknown';
    const status = ({
      doc_summarizer_no_prisma: 500,
      doc_summarizer_bad_args: 400,
      doc_summarizer_file_not_found: 404,
      doc_summarizer_empty_text: 422,
      doc_summarizer_no_client: 500,
      doc_summarizer_llm_failed: 502,
      doc_summarizer_invalid_json: 502,
    })[code] || 500;
    if (status >= 500) console.warn('[files] /:id/summary failed:', code, err && err.message);
    return res.status(status).json({ error: err && err.message, code });
  }
});

/**
 * POST /api/files/:id/cite — answer a question against a single file
 * the caller owns, returning the answer with NATIVE Anthropic citations
 * (char_location offsets back into the file's extracted text).
 *
 * Body: { question: string, options?: { model?, maxTokens?, temperature? } }
 *
 * Why a dedicated endpoint vs. the chat path:
 *   The native Citations API gives us verified character offsets that
 *   the existing post-hoc citation-engine.js cannot guarantee. Surfacing
 *   it on its own endpoint lets the frontend render a "doc Q&A" view
 *   with click-to-jump-to-source without changing the broader chat
 *   pipeline. A future commit can wire this into the chat path behind
 *   a feature flag once the UX for inline citation pointers is stable.
 *
 * Errors:
 *   400  anthropic_citations_bad_args / anthropic_citations_empty_question
 *   404  anthropic_citations_file_not_found
 *   422  anthropic_citations_empty_text
 *   500  anthropic_citations_no_prisma
 *   502  anthropic_citations_llm_failed
 *   503  anthropic_citations_disabled (no ANTHROPIC_API_KEY)
 */
router.post('/:id/cite', authenticateToken, async (req, res) => {
  try {
    const { question, options, verify } = req.body || {};
    const opts = options && typeof options === 'object' ? { ...options } : {};
    if (verify) {
      // Opt-in NLI faithfulness verification. The NLI module picks the
      // HuggingFace backend automatically when HUGGINGFACE_API_TOKEN is
      // set in env; otherwise it falls back to LLM-as-judge with our
      // existing OpenAI client. Either way the caller gets
      // citation.verification = { label, score, reason, backend }.
      opts.verify = true;
      opts.nli = { openai };
    }
    const out = await anthropicCitations.answerFileQuestionWithCitations({
      prisma,
      userId: req.user.id,
      fileId: req.params.id,
      question,
      options: opts,
    });
    return res.json({
      fileId: out.fileId,
      fileTitle: out.fileTitle,
      answer: out.text,
      citations: out.citations,
      blocks: out.blocks,
      usage: out.usage,
    });
  } catch (err) {
    const code = err && err.code ? err.code : 'anthropic_citations_unknown';
    const status = ({
      anthropic_citations_no_prisma: 500,
      anthropic_citations_bad_args: 400,
      anthropic_citations_empty_question: 400,
      anthropic_citations_no_documents: 400,
      anthropic_citations_file_not_found: 404,
      anthropic_citations_empty_text: 422,
      anthropic_citations_disabled: 503,
      anthropic_citations_llm_failed: 502,
    })[code] || 500;
    if (status >= 500 && status !== 503) console.warn('[files] /:id/cite failed:', code, err && err.message);
    return res.status(status).json({ error: err && err.message, code });
  }
});

/**
 * POST /api/files/:id/decompose-query — split a multi-hop question
 * about THIS file into atomic sub-queries via the query-decomposer.
 *
 * Body: { question: string, options?: { languageHint? } }
 *
 * Why per-file: the frontend's "ask the document" flow already has a
 * fileId in scope, so this stays consistent with the sibling
 * /:id/summary and /:id/cite endpoints. The fileId is also used to
 * verify ownership AND to pass the file's MIME type as a language /
 * domain hint that biases the decomposer toward the right vocabulary
 * (e.g. legal vs financial vs research). The decomposer does NOT
 * read the file body — that's the retrieval step's job, run
 * separately by the frontend per sub-query.
 *
 * Errors:
 *   400  query_decomposer_empty            blank question
 *   404  anthropic_citations_file_not_found wrong fileId / owner
 *                                            (reused for symmetry with /:id/cite)
 *   500  query_decomposer_no_client        server misconfig
 *   502  query_decomposer_llm_failed       OpenAI error
 *   502  query_decomposer_invalid_json     model returned non-JSON
 */
router.post('/:id/decompose-query', authenticateToken, async (req, res) => {
  try {
    const file = await prisma.file.findFirst({
      where: { id: req.params.id, userId: req.user.id },
      select: { id: true, originalName: true, mimeType: true },
    });
    if (!file) {
      return res.status(404).json({
        error: 'file not found or not owned by user',
        code: 'anthropic_citations_file_not_found',
      });
    }

    const { question, options } = req.body || {};
    const out = await queryDecomposer.decomposeQuery({
      openai,
      question,
      options: {
        ...(options && typeof options === 'object' ? options : {}),
        languageHint: options?.languageHint || (file.mimeType ? `mime=${file.mimeType}` : ''),
      },
    });
    return res.json({
      fileId: file.id,
      fileTitle: file.originalName || `file-${file.id.slice(0, 8)}`,
      ...out,
    });
  } catch (err) {
    const code = err && err.code ? err.code : 'query_decomposer_unknown';
    const status = ({
      query_decomposer_empty: 400,
      query_decomposer_no_client: 500,
      query_decomposer_llm_failed: 502,
      query_decomposer_invalid_json: 502,
    })[code] || 500;
    if (status >= 500) console.warn('[files] /:id/decompose-query failed:', code, err && err.message);
    return res.status(status).json({ error: err && err.message, code });
  }
});

/**
 * POST /api/files/:id/deep-ask — multi-hop Q&A in one call.
 *
 * Composes:
 *   1. Query decomposer (OpenAI Structured Outputs strict)
 *   2. Anthropic Citations API (verified char_location offsets)
 *   3. (optional) NLI faithfulness verification on every citation
 *
 * Body: { question: string, verify?: boolean, options? }
 *
 * Why a separate endpoint: /:id/cite handles single-shot Q&A; this
 * endpoint handles questions the model should DECOMPOSE first
 * ("compare X and Y", "what does the report say about A and B"). The
 * frontend can route to either based on the question shape or expose
 * both as user-facing modes ("simple ask" vs "deep ask").
 *
 * Errors map to the same codes as /:id/cite plus:
 *   400  deep_ask_bad_args            missing prisma / userId / fileId / question
 *   500  deep_ask_no_openai           server openai client missing
 *   500  deep_ask_no_anthropic_module wiring bug (should be caught in CI)
 */
router.post('/:id/deep-ask', authenticateToken, async (req, res) => {
  try {
    const { question, verify, options } = req.body || {};
    const opts = options && typeof options === 'object' ? { ...options } : {};
    if (verify) opts.verify = true;

    const out = await deepAsk.deepAskFile({
      prisma,
      openai,
      anthropicCitations,
      userId: req.user.id,
      fileId: req.params.id,
      question,
      options: opts,
    });

    return res.json({
      fileId: out.fileId,
      fileTitle: out.fileTitle,
      decomposition: out.decomposition,
      answer: out.answer,
      blocks: out.blocks,
      citations: out.citations,
      usage: out.usage,
      ...(out.verification ? { verification: out.verification } : {}),
    });
  } catch (err) {
    const code = err && err.code ? err.code : 'deep_ask_unknown';
    const status = ({
      // deep-ask own codes
      deep_ask_bad_args: 400,
      deep_ask_no_openai: 500,
      deep_ask_no_anthropic_module: 500,
      // bubbled from decomposer
      query_decomposer_empty: 400,
      query_decomposer_no_client: 500,
      query_decomposer_llm_failed: 502,
      query_decomposer_invalid_json: 502,
      // bubbled from citations / file ownership
      anthropic_citations_no_prisma: 500,
      anthropic_citations_bad_args: 400,
      anthropic_citations_empty_question: 400,
      anthropic_citations_no_documents: 400,
      anthropic_citations_file_not_found: 404,
      anthropic_citations_empty_text: 422,
      anthropic_citations_disabled: 503,
      anthropic_citations_llm_failed: 502,
    })[code] || 500;
    if (status >= 500 && status !== 503) console.warn('[files] /:id/deep-ask failed:', code, err && err.message);
    return res.status(status).json({ error: err && err.message, code });
  }
});

module.exports = router;
