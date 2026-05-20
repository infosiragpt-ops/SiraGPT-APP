'use strict';
const { z } = require('zod');

const uploadFileSchema = z.object({
  collection: z.string().min(1).max(64).optional(),
});

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

const fileFilterSchema = z.object({
  name: z.string().min(1).max(500),
  size: z.number().int().min(1).max(MAX_FILE_SIZE),
  mimeType: z.string().max(200),
});

module.exports = {
  uploadFileSchema,
  fileFilterSchema,
  MAX_FILE_SIZE,
};
