'use strict';

const { z } = require('zod');

const OrchestrationRequestSchema = z.object({
  sessionId: z.string().min(1).max(128).optional(),
  threadId: z.string().min(1).max(128).optional(),
  model: z.string().min(1).max(120).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(200000).optional(),
  stream: z.boolean().optional(),
  taskType: z.enum(['deep_reasoning', 'speed', 'multimodal', 'code', 'embeddings', 'default']).optional(),
});

const OrchestrationCompleteRequestSchema = OrchestrationRequestSchema.extend({
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant', 'system', 'tool']),
    content: z.string().max(200000),
  })).min(1).max(200),
  prompt: z.string().max(200000).optional(),
  files: z.array(z.object({
    name: z.string().max(255).optional(),
    mimeType: z.string().max(255).optional(),
    content: z.string().max(2000000).optional(),
    url: z.string().url().max(2048).optional(),
  })).max(50).optional(),
}).strict();

const OrchestrationEmbedRequestSchema = OrchestrationRequestSchema.extend({
  input: z.union([z.string().max(200000), z.array(z.string().max(200000)).min(1).max(500)]),
}).strict();

const MemoryRecallRequestSchema = z.object({
  userId: z.string().uuid().optional(),
  query: z.string().min(1).max(10000),
  k: z.number().int().min(1).max(20).optional(),
}).strict();

const MemoryStoreRequestSchema = z.object({
  userId: z.string().uuid(),
  content: z.string().min(1).max(4096),
  category: z.string().max(128).optional(),
  importance: z.number().min(0).max(1).optional(),
  metadata: z.record(z.any()).optional(),
}).strict();

const WebSearchRequestSchema = z.object({
  query: z.string().min(1).max(1000),
  maxResults: z.number().int().min(1).max(20).optional(),
}).strict();

const LangGraphRunRequestSchema = z.object({
  threadId: z.string().min(1).max(128).optional(),
  input: z.object({
    messages: z.array(z.object({
      role: z.enum(['user', 'assistant', 'system', 'tool']),
      content: z.string().max(200000),
    })).min(1).max(200).optional(),
    prompt: z.string().max(200000).optional(),
    files: z.array(z.object({
      name: z.string().max(255).optional(),
      mimeType: z.string().max(255).optional(),
      content: z.string().max(2000000).optional(),
      url: z.string().url().max(2048).optional(),
    })).max(50).optional(),
    taskType: z.enum(['deep_reasoning', 'speed', 'multimodal', 'code', 'embeddings', 'default']).optional(),
  }),
  userId: z.string().max(128),
  metadata: z.record(z.any()).optional(),
}).strict();

const MultiAgentTeamRequestSchema = z.object({
  intent: z.string().min(1).max(5000),
  agents: z.array(z.string().min(1).max(64)).min(1).max(10).optional(),
}).strict();

const R2UploadRequestSchema = z.object({
  userId: z.string().max(128).optional(),
  fileName: z.string().min(1).max(512),
  contentType: z.string().min(1).max(255).optional(),
  prefix: z.string().max(256).optional(),
}).strict();

module.exports = {
  OrchestrationCompleteRequestSchema,
  OrchestrationEmbedRequestSchema,
  MemoryRecallRequestSchema,
  MemoryStoreRequestSchema,
  WebSearchRequestSchema,
  LangGraphRunRequestSchema,
  MultiAgentTeamRequestSchema,
  R2UploadRequestSchema,
};

// Re-export generic validation middleware factory
module.exports.createZodValidator = function createZodValidator(schema, opts = {}) {
  return function zodValidator(req, res, next) {
    try {
      const data = schema.parse(req.body || {});
      req.validatedBody = data;
      req.body = data;
      next();
    } catch (err) {
      if (err.issues) {
        const formatted = err.issues.map(i => ({
          field: i.path.join('.'),
          message: i.message,
          code: i.code,
        }));
        return res.status(400).json({ error: 'Validation failed', details: formatted });
      }
      next(err);
    }
  };
};
