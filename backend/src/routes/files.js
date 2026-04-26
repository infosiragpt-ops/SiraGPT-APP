const express = require('express');
const fsSync = require('fs');
const { authenticateToken } = require('../middleware/auth');
const upload = require('../middleware/upload');
const fileProcessor = require('../services/fileProcessor');
const documentRenderer = require('../services/documentRenderer');
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
  if (docs.length === 0) return false;

  setImmediate(async () => {
    try {
      const result = await operationalRag.ensureIndexed({
        rag,
        userId,
        collection: operationalRag.DEFAULT_COLLECTION,
        docs,
      });
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
    } catch (err) {
      console.warn('[files] default RAG indexing failed:', err.message || err);
    }
  });

  return true;
}

/**
 * Detect a file's true MIME by reading its leading bytes (magic bytes).
 *
 * Why we don't trust `file.mimetype` from multer:
 *   - Browsers often report `application/octet-stream` for clipboard
 *     pastes, drag-from-other-apps, HEIC on Linux, and some ZIP-based
 *     office formats.
 *   - Adversarial uploads can spoof the MIME header.
 *   - Magic-byte detection is the only reliable source of truth.
 *
 * Strategy:
 *   - Detect → if confidence is high, overwrite the stored mimetype.
 *   - Plain-text formats (md / csv / json / xml) have NO magic bytes,
 *     so a `null` detection means "trust the original mimetype".
 *
 * Returns the (possibly corrected) mime string. Never throws — failure
 * just falls back to the multer-reported mimetype.
 */
async function detectMime(filePath, fallbackMime) {
  try {
    const { fileTypeFromFile } = await loadFileType();
    const detected = await fileTypeFromFile(filePath);
    if (detected && detected.mime) return detected.mime;
  } catch (e) {
    console.warn('[files] magic-byte detection failed:', e.message);
  }
  return fallbackMime;
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
        // Magic-byte detection — overrides browser-reported mimetype when
        // it's wrong (octet-stream, spoofed, or Office ZIP misidentified).
        // We mutate `file.mimetype` so downstream consumers (file
        // processor, OpenAI uploader, Prisma row, response payload) all
        // see the corrected value with no extra plumbing.
        const detectedMime = await detectMime(file.path, file.mimetype);
        if (detectedMime && detectedMime !== file.mimetype) {
          console.log(`[files] mime corrected for ${file.originalname}: ${file.mimetype} → ${detectedMime}`);
          file.mimetype = detectedMime;
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

        processedFiles.push({
          id: fileRecord.id,
          name: file.originalname,
          size: file.size,
          type: file.mimetype,
          url: `/uploads/${req.user.id}/${file.filename}`,
          thumbnailUrl: thumbnailPath ? `/uploads/${req.user.id}/${path.basename(thumbnailPath)}` : null,
          extractedText: result.extractedText,
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
