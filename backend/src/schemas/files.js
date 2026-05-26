'use strict';

/**
 * Zod schemas for /api/files responses.
 *
 * File uploads themselves are multipart/form-data so we can't validate the
 * REQUEST body shape with Zod here — multer parses files before we see them.
 * What we DO validate is the JSON response we send back, and any FileMetadata
 * GET/PATCH bodies the FE consumes.
 */

const { z } = require('zod');

const FileMetadataSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    name: z.string(),
    originalName: z.string().optional(),
    mimeType: z.string().optional(),
    size: z.number().int().nonnegative().optional(),
    extension: z.string().nullable().optional(),
    status: z.string().optional(),
    userId: z.union([z.string(), z.number()]).optional(),
    chatId: z.union([z.string(), z.number()]).nullable().optional(),
    storageKey: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    error: z.string().nullable().optional(),
    metadata: z.record(z.any()).nullable().optional(),
    createdAt: z.union([z.string(), z.date()]).optional(),
    updatedAt: z.union([z.string(), z.date()]).optional(),
  })
  .passthrough();

const FileUploadResponseSchema = z
  .object({
    files: z.array(FileMetadataSchema),
    failed: z
      .array(
        z.object({
          name: z.string(),
          reason: z.string(),
        }),
      )
      .optional(),
    batchId: z.string().optional(),
    intent: z.record(z.any()).nullable().optional(),
  })
  .passthrough();

module.exports = {
  FileMetadataSchema,
  FileUploadResponseSchema,
};
