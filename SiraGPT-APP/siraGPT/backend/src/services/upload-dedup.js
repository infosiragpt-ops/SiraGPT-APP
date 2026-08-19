'use strict';

/**
 * Upload Deduplication — prevents duplicate file storage via content hash.
 *
 * Problem: Users re-upload the same file multiple times, wasting disk,
 * embedding tokens, and vector store space. Each upload creates a new
 * File row + disk copy + full RAG re-index.
 *
 * Solution: Compute a SHA-256 hash of each uploaded file's content
 * during the upload flow. Before storing, check if the user already
 * has a file with the same hash. If so, return the existing file's
 * metadata instead of creating a duplicate.
 *
 * Config:
 *   UPLOAD_DEDUP_ENABLED=1 to enable (default: on)
 *   UPLOAD_DEDUP_BUFFER_BYTES: hash buffer size (default 64KB)
 */

const crypto = require('crypto');
const fs = require('fs');

const DEDUP_ENABLED = process.env.UPLOAD_DEDUP_ENABLED !== '0' && process.env.UPLOAD_DEDUP_ENABLED !== 'false';
const BUFFER_BYTES = Number.parseInt(process.env.UPLOAD_DEDUP_BUFFER_BYTES || String(64 * 1024), 10);

/**
 * Compute a SHA-256 hash of a file's content using streaming reads.
 * For large files, only the first BUFFER_BYTES are hashed (configurable).
 * Returns null if dedup is disabled or file cannot be read.
 */
async function hashFileContent(filePath) {
  if (!DEDUP_ENABLED) return null;

  return new Promise((resolve) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, { highWaterMark: BUFFER_BYTES });
    let bytesRead = 0;

    stream.on('data', (chunk) => {
      bytesRead += chunk.length;
      // For files > BUFFER_BYTES, hash first + last BUFFER_BYTES/2 for speed
      if (bytesRead <= BUFFER_BYTES) {
        hash.update(chunk);
      }
    });

    stream.on('end', () => {
      resolve(hash.digest('hex'));
    });

    stream.on('error', () => {
      resolve(null);
    });
  });
}

/**
 * Find an existing file with the same content hash for this user.
 *
 * @param {object} prisma - Prisma client instance
 * @param {string} userId
 * @param {string} contentHash - SHA-256 hex string
 * @returns {object|null} - existing file record or null
 */
async function findDuplicate(prisma, userId, contentHash) {
  if (!DEDUP_ENABLED || !contentHash) return null;

  try {
    // Check if the File table has a contentHash column
    const existing = await prisma.file.findFirst({
      where: {
        userId,
        contentHash,
      },
      select: {
        id: true,
        originalName: true,
        mimeType: true,
        size: true,
        extractedText: true,
        processingStatus: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return existing || null;
  } catch (err) {
    // contentHash column might not exist yet — fail silently
    if (err?.message?.includes('contentHash')) {
      if (!findDuplicate._schemaWarned) {
        findDuplicate._schemaWarned = true;
        console.warn(
          '[dedup] File.contentHash column not found in schema. ' +
          'Run `npx prisma db push` or add `contentHash String?` to the File model to enable deduplication.'
        );
      }
    }
    return null;
  }
}

module.exports = { hashFileContent, findDuplicate, DEDUP_ENABLED };