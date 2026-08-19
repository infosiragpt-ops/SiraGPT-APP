'use strict';
const { z } = require('zod');

const generateRequestSchema = z.object({
  prompt: z.string().min(1, 'Prompt is required').max(50000, 'Prompt too long'),
  model: z.string().min(1).max(100).optional(),
  provider: z.string().min(1).max(50).optional(),
  chatId: z.string().min(1).max(50).optional(),
  files: z.array(z.object({
    id: z.string().optional(),
    name: z.string().max(200),
    mimeType: z.string().max(100).optional(),
    content: z.string().optional(),
  })).max(50).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(32000).optional(),
  regenerate: z.boolean().optional(),
  streamId: z.string().max(100).optional(),
});

const intentRequestSchema = z.object({
  text: z.string().min(1).max(10000),
  context: z.record(z.unknown()).optional(),
});

const stopStreamSchema = z.object({
  streamId: z.string().min(1),
});

module.exports = {
  generateRequestSchema,
  intentRequestSchema,
  stopStreamSchema,
};
