'use strict';

const crypto = require('crypto');
const prisma = require('../config/database');
const fileProcessingStatus = require('./file-processing-status');
const documentIntelligence = require('./document-intelligence');
const documentIntentAnalyzer = require('./document-intent-analyzer');
const operationalRag = require('./rag/operational-runtime');
const rag = require('./rag-service');

const MAX_PASTE_LENGTH = Number.parseInt(process.env.SIRAGPT_AUTO_FILE_MAX_PASTE || '2000000', 10);
const MIN_PASTE_LENGTH = Number.parseInt(process.env.SIRAGPT_AUTO_FILE_MIN_PASTE || '200', 10);
const AUTO_FILE_TTL_MS = Number.parseInt(process.env.SIRAGPT_AUTO_FILE_TTL_MS || `${7 * 24 * 60 * 60 * 1000}`, 10);

const CONTENT_TYPE_MAP = {
  json: 'application/json',
  csv:  'text/csv',
  xml:  'application/xml',
  html: 'text/html',
  yaml: 'application/x-yaml',
  md:   'text/markdown',
  txt:  'text/plain',
  sql:  'application/sql',
  log:  'text/plain',
  ts:   'text/typescript',
  js:   'text/javascript',
  py:   'text/x-python',
  r:    'text/x-r',
  sh:   'text/x-shellscript',
};

const STRUCTURED_PATTERNS = [
  { pattern: /^\s*[\[{]/m, format: 'json', mime: 'application/json' },
  { pattern: /^[\w\s]+,[\w\s]+,/m, format: 'csv', mime: 'text/csv' },
  { pattern: /^<\?xml|^<\w+/m, format: 'xml', mime: 'application/xml' },
  { pattern: /^<!DOCTYPE|^<html/mi, format: 'html', mime: 'text/html' },
  { pattern: /^---\s*$/m, format: 'yaml', mime: 'application/x-yaml' },
  { pattern: /^#{1,6}\s+/m, format: 'md', mime: 'text/markdown' },
  { pattern: /^(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\s/im, format: 'sql', mime: 'application/sql' },
  { pattern: /^(import |from |def |class |if __name__)/m, format: 'py', mime: 'text/x-python' },
  { pattern: /^(const |let |var |function |export |import )/m, format: 'js', mime: 'text/javascript' },
  { pattern: /^(interface |type |enum |namespace |export )/m, format: 'ts', mime: 'text/typescript' },
  { pattern: /^#!/m, format: 'sh', mime: 'text/x-shellscript' },
  { pattern: /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/m, format: 'log', mime: 'text/plain' },
];

function detectContentType(content) {
  if (!content || typeof content !== 'string') return { format: 'txt', mime: 'text/plain' };
  for (const { pattern, format, mime } of STRUCTURED_PATTERNS) {
    if (pattern.test(content)) return { format, mime };
  }
  return { format: 'txt', mime: 'text/plain' };
}

function generateAutoFileName(content, detected) {
  const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 8);
  const ts = Date.now().toString(36);
  return `pasted-${ts}-${hash}.${detected.format}`;
}

function shouldAutoFile(content) {
  if (!content || typeof content !== 'string') return false;
  const trimmed = content.trim();
  if (trimmed.length < MIN_PASTE_LENGTH) return false;
  if (trimmed.length > MAX_PASTE_LENGTH) return false;
  return true;
}

function isStructuredContent(content) {
  if (!content || typeof content !== 'string') return false;
  const trimmed = content.trim();
  for (const { pattern } of STRUCTURED_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }
  const lineCount = trimmed.split('\n').length;
  return lineCount >= 10;
}

async function ingestPastedContent(userId, content, opts = {}) {
  if (!shouldAutoFile(content)) {
    return { autoFiled: false, reason: 'content_too_short_or_invalid' };
  }

  const detected = detectContentType(content);
  const fileName = opts.fileName || generateAutoFileName(content, detected);
  const sizeBytes = Buffer.byteLength(content, 'utf8');

  try {
    const fileRecord = await prisma.file.create({
      data: {
        userId,
        originalName: fileName,
        filename: fileName,
        // Virtual (pasted) document — no file on disk. The File model requires
        // a non-null `path`; use a synthetic, namespaced one.
        path: `auto/${fileName}`,
        mimeType: detected.mime,
        size: sizeBytes,
        extractedText: content,
        processingStage: 'uploaded',
        source: 'paste',
        metadata: {
          autoFiled: true,
          detectedFormat: detected.format,
          charCount: content.length,
          lineCount: content.split('\n').length,
          createdAt: new Date().toISOString(),
        },
      },
    });

    await fileProcessingStatus.setStage(prisma, fileRecord.id, 'extracting', { userId });

    const analysis = await documentIntelligence.analyzeFile(fileRecord, content);

    await prisma.file.update({
      where: { id: fileRecord.id },
      data: {
        processingStage: 'analyzing',
        extractedText: content,
        metadata: {
          ...fileRecord.metadata,
          analysis: {
            language: analysis.language,
            chunkCount: analysis.chunks?.length || 0,
            tableCount: analysis.tables?.length || 0,
            hasUsefulText: analysis.hasUsefulText,
          },
        },
      },
    });

    scheduleAutoFileRagIndex(userId, fileRecord, content);

    let intentAnalysis = null;
    try {
      intentAnalysis = await documentIntentAnalyzer.analyzeSingleDocument({
        id: fileRecord.id,
        name: fileName,
        text: content,
        mimeType: detected.mime,
        size: sizeBytes,
      });
    } catch (_e) {
      intentAnalysis = null;
    }

    await fileProcessingStatus.setStage(prisma, fileRecord.id, 'ready', { userId });

    return {
      autoFiled: true,
      fileId: fileRecord.id,
      fileName,
      format: detected.format,
      mime: detected.mime,
      sizeBytes,
      charCount: content.length,
      lineCount: content.split('\n').length,
      analysis: {
        language: analysis.language,
        chunkCount: analysis.chunks?.length || 0,
        tableCount: analysis.tables?.length || 0,
      },
      intent: intentAnalysis,
    };
  } catch (err) {
    return {
      autoFiled: false,
      reason: 'ingestion_failed',
      error: err.message,
    };
  }
}

function scheduleAutoFileRagIndex(userId, fileRecord, text) {
  const docs = operationalRag.normaliseDocs([{
    ...fileRecord,
    extractedText: text,
  }]);
  if (docs.length === 0) return;

  setImmediate(async () => {
    try {
      await fileProcessingStatus.setStage(prisma, fileRecord.id, 'chunking', { userId });
      await fileProcessingStatus.setStage(prisma, fileRecord.id, 'embedding', { userId });
      await operationalRag.ensureIndexed({
        rag,
        userId,
        collection: operationalRag.DEFAULT_COLLECTION,
        docs,
      });
      await fileProcessingStatus.setStage(prisma, fileRecord.id, 'indexing', { userId });
      await fileProcessingStatus.setStage(prisma, fileRecord.id, 'ready', { userId });
    } catch (err) {
      console.warn('[auto-file-bridge] RAG indexing failed:', err.message);
    }
  });
}

async function ingestDroppedFiles(userId, files, opts = {}) {
  const results = [];
  for (const file of files) {
    try {
      const content = file.content || file.text || file.extractedText;
      if (content && shouldAutoFile(content)) {
        const result = await ingestPastedContent(userId, content, {
          fileName: file.name || file.originalName,
        });
        results.push(result);
      } else {
        results.push({ autoFiled: false, reason: 'content_too_short', fileName: file.name });
      }
    } catch (err) {
      results.push({ autoFiled: false, reason: 'error', error: err.message, fileName: file.name });
    }
  }
  return results;
}

async function getAutoFilesForChat(userId, chatId, opts = {}) {
  const limit = Math.min(opts.limit || 20, 50);
  const files = await prisma.file.findMany({
    where: {
      userId,
      source: 'paste',
      createdAt: { gte: new Date(Date.now() - AUTO_FILE_TTL_MS) },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      originalName: true,
      mimeType: true,
      size: true,
      processingStage: true,
      createdAt: true,
      metadata: true,
    },
  });
  return files;
}

module.exports = {
  ingestPastedContent,
  ingestDroppedFiles,
  getAutoFilesForChat,
  shouldAutoFile,
  isStructuredContent,
  detectContentType,
  MIN_PASTE_LENGTH,
  MAX_PASTE_LENGTH,
};
