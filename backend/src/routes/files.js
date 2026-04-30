const express = require('express');
const fsSync = require('fs');
const { authenticateToken } = require('../middleware/auth');
const upload = require('../middleware/upload');
const { ALLOWED_MIMES, ALLOWED_EXTENSIONS } = require('../middleware/upload');
const fileProcessingStatus = require('../services/file-processing-status');
const fileProcessor = require('../services/fileProcessor');
const documentRenderer = require('../services/documentRenderer');
const documentIntelligence = require('../services/document-intelligence');
const prisma = require('../config/database');
const rag = require('../services/rag-service');
const operationalRag = require('../services/rag/operational-runtime');
const fs = require('fs').promises;
const path = require('path');
const OpenAI = require('openai');

const router = express.Router();

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
    try {
      await fileProcessingStatus.setStage(prisma, fileRecord.id, 'embedding', { userId });
      const result = await operationalRag.ensureIndexed({
        rag,
        userId,
        collection: operationalRag.DEFAULT_COLLECTION,
        docs,
      });
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
    } catch (err) {
      console.warn('[files] default RAG indexing failed:', err.message || err);
      await fileProcessingStatus.setStage(prisma, fileRecord.id, 'failed', {
        userId,
        error: `rag_indexing: ${err && err.message ? err.message : String(err)}`,
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
 * Returns `{ mime, source }`:
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
      return { mime: detected.mime, source: 'magic-bytes' };
    }
  } catch (e) {
    console.warn('[files] magic-byte detection failed:', e.message);
  }
  return { mime: fallbackMime, source: 'fallback' };
}

/**
 * After magic-byte detection corrected the mime, re-check it against
 * the allowlist. The pre-multer filter validates the *declared* mime;
 * this guard catches the case where the real content disagrees and
 * lands outside what we accept (e.g., a renamed executable).
 *
 * Plain-text detections (`source: 'fallback'`) are trusted — they
 * already passed the extension/declared-mime gate at the multer
 * boundary and have no detectable signature.
 */
function isContentTypeAllowed(detection) {
  if (detection.source !== 'magic-bytes') return true;
  return ALLOWED_MIMES.has(detection.mime);
}

async function unlinkQuiet(p) {
  try { await fs.unlink(p); } catch (_) { /* already gone */ }
}

// Upload files
router.post('/upload', authenticateToken, upload.array('files', 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const processedFiles = [];

    for (const file of req.files) {
      try {
        // Magic-byte detection — sees the *real* content type by reading
        // the file's leading bytes. Two responsibilities:
        //   1. Correct the mimetype when the browser misreported it
        //      (octet-stream, spoof, Office-ZIP).
        //   2. Reject the upload when the real type lands outside the
        //      allowlist — multer's pre-gate trusted the declared mime,
        //      so we close the spoofing loophole here.
        const detection = await detectMime(file.path, file.mimetype);
        if (!isContentTypeAllowed(detection)) {
          console.warn(
            `[files] rejected ${file.originalname}: declared=${file.mimetype} ` +
            `real=${detection.mime} (not in allowlist)`,
          );
          await unlinkQuiet(file.path);
          processedFiles.push({
            name: file.originalname,
            size: file.size,
            type: file.mimetype,
            success: false,
            error: `Tipo real del archivo no permitido (${detection.mime}); el contenido no coincide con la extensión declarada.`,
            code: 'magic_byte_mismatch',
            detectedMime: detection.mime,
          });
          continue;
        }
        if (detection.mime && detection.mime !== file.mimetype) {
          console.log(`[files] mime corrected for ${file.originalname}: ${file.mimetype} → ${detection.mime}`);
          file.mimetype = detection.mime;
        }

        // Process file content
        const result = await fileProcessor.processFile(file);

        // Generate thumbnail for images
        const thumbnailPath = await fileProcessor.generateThumbnail(file.path, file.mimetype);

        // Upload to OpenAI Files API if it's a supported file type
        let openaiFileId = null;
        if (file.mimetype === 'application/pdf' ||
          file.mimetype.startsWith('text/') ||
          file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
          file.mimetype === 'application/vnd.ms-powerpoint' ||
          file.mimetype === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {
          try {
            const fileStream = await fs.readFile(file.path);
            const openaiFile = await openai.files.create({
              file: new File([fileStream], file.originalname, { type: file.mimetype }),
              purpose: 'assistants'
            });
            openaiFileId = openaiFile.id;
          } catch (openaiError) {
            console.error('OpenAI file upload error:', openaiError);
          }
        }

        // Save file record to database
        const fileRecord = await prisma.file.create({
          data: {
            userId: req.user.id,
            filename: file.filename,
            originalName: file.originalname,
            mimeType: file.mimetype,
            size: file.size,
            path: file.path,
            extractedText: result.extractedText,
            openaiFileId: openaiFileId
          }
        });

        const ragQueued = scheduleDefaultRagIndex(req.user.id, fileRecord);
        const ocrMeta = serializeOcrMeta(result);
        let analysis = null;
        try {
          analysis = await documentIntelligence.analyzeFile(prisma, {
            userId: req.user.id,
            fileRecord,
            extractionResult: result,
            force: true,
          });
        } catch (analysisError) {
          console.warn('[files] document analysis failed:', analysisError.message || analysisError);
        }

        processedFiles.push({
          id: fileRecord.id,
          name: file.originalname,
          size: file.size,
          type: file.mimetype,
          url: `/uploads/${req.user.id}/${file.filename}`,
          thumbnailUrl: thumbnailPath ? `/uploads/${req.user.id}/${path.basename(thumbnailPath)}` : null,
          extractedText: result.extractedText,
          ...ocrMeta,
          ...serializeAnalysisMeta(analysis),
          openaiFileId: openaiFileId,
          ragIndexed: ragQueued ? 'queued' : 'skipped',
          success: result.success,
          error: result.error
        });
      } catch (error) {
        console.error('File processing error:', error);
        processedFiles.push({
          name: file.originalname,
          size: file.size,
          type: file.mimetype,
          success: false,
          ocrStatus: 'failed',
          ocrConfidence: 0,
          ocrProvider: null,
          error: error.message
        });
      }
    }

    res.json({
      message: 'Files processed successfully',
      files: processedFiles
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'File upload failed' });
  }
});

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

// Get user files
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { page = 1, limit = 20, type } = req.query;
    const skip = (page - 1) * limit;

    const where = {
      userId: req.user.id,
      ...(type && { mimeType: { startsWith: type } })
    };

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
        skip: parseInt(skip),
        take: parseInt(limit),
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
      if (!fsSync.existsSync(file.path)) {
        return res.status(404).json({ error: 'File not found on disk' });
      }
      const baseName = path.basename(file.originalName, path.extname(file.originalName));
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${baseName}.pdf"`);
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.setHeader('X-Render-Engine', 'native-pdf');
      res.setHeader('X-Render-From-Cache', 'true');
      return fsSync.createReadStream(file.path).pipe(res);
    }

    if (!documentRenderer.isConvertible(file.mimeType, file.originalName)) {
      return res.status(415).json({
        error: 'Format not convertible',
        mimeType: file.mimeType,
      });
    }

    let pdfPath;
    try {
      const out = await documentRenderer.renderToPdf({
        id: file.id,
        path: file.path,
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
    }

    const baseName = path.basename(file.originalName, path.extname(file.originalName));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${baseName}.pdf"`);
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

    // Delete file from filesystem
    try {
      await fs.unlink(file.path);
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

module.exports = router;
