'use strict';

const { z } = require('zod');

const INLINE_FILE_CONTENT_MAX_CHARS = 10 * 1024 * 1024;
const INLINE_FILE_MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i;

const chatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string().min(1).max(100000),
  name: z.string().max(100).optional(),
  tool_calls: z.array(z.any()).optional(),
  tool_call_id: z.string().optional(),
});

const inlineFileSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().max(500),
  mimeType: z.string()
    .max(200)
    .regex(INLINE_FILE_MIME_RE, { message: 'files.mimeType.invalid' })
    .optional(),
  content: z.string()
    .max(INLINE_FILE_CONTENT_MAX_CHARS, { message: 'files.content.too_large' })
    .optional(),
  url: z.string().url().optional(),
});

const aiGenerateRequestSchema = z.object({
  messages: z.array(chatMessageSchema).min(1).max(100),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(100000).optional(),
  stream: z.boolean().optional(),
  model: z.string().max(200).optional(),
  taskType: z.enum(['deep_reasoning', 'speed', 'multimodal', 'code', 'embeddings', 'default']).optional(),
  files: z.array(inlineFileSchema).optional(),
  cacheBypass: z.boolean().optional(),
  sessionId: z.string().max(200).optional(),
  projectId: z.string().uuid().optional(),
});

const fileUploadSchema = z.object({
  files: z.array(z.object({
    fieldname: z.string(),
    originalname: z.string().max(1000),
    encoding: z.string(),
    mimetype: z.string(),
    size: z.number().max(100 * 1024 * 1024),
    buffer: z.instanceof(Buffer).optional(),
  })).min(1).max(50),
  projectId: z.string().uuid().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const promptInjectionPatterns = [
  /ignore\s+(all\s+)?(previous\s+)?(instructions?|prompts?|rules?)/i,
  /forget\s+(everything|all|previous)/i,
  /system:\s*you are now/i,
  /new system prompt/i,
  /\[system\]/i,
  /<\|im_start\|>/i,
  /<\|im_end\|>/i,
  /pretend\s+(you are|to be)/i,
  /act as (if )?(you are|a )/i,
  /disregard/i,
  /override/i,
];

function sanitizeAgainstPromptInjection(text) {
  if (typeof text !== 'string') return text;
  let sanitized = text;
  for (const pattern of promptInjectionPatterns) {
    if (pattern.test(sanitized)) {
      sanitized = sanitized.replace(pattern, '[REDACTED]');
    }
  }
  return sanitized;
}

function sanitizeMessages(messages = []) {
  return messages.map(m => ({
    ...m,
    content: sanitizeAgainstPromptInjection(m.content),
  }));
}

const xssPatterns = {
  script: /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
  eventHandler: /\bon\w+\s*=/gi,
  javascriptUrl: /javascript\s*:/gi,
  dataUri: /data\s*:[^;]*;base64/gi,
  vbscript: /vbscript\s*:/gi,
  expressionCss: /expression\s*\(/gi,
  evalCode: /\beval\s*\(/gi,
};

function sanitizeAgainstXSS(text) {
  if (typeof text !== 'string') return text;
  let sanitized = text;
  for (const [, pattern] of Object.entries(xssPatterns)) {
    sanitized = sanitized.replace(pattern, '');
  }
  return sanitized
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function validateAndSanitize(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) {
    const err = new Error('Validation failed');
    err.status = 400;
    err.details = result.error.flatten();
    throw err;
  }
  return result.data;
}

module.exports = {
  aiGenerateRequestSchema,
  chatMessageSchema,
  fileUploadSchema,
  inlineFileSchema,
  promptInjectionPatterns,
  sanitizeAgainstPromptInjection,
  sanitizeAgainstXSS,
  sanitizeMessages,
  validateAndSanitize,
  xssPatterns,
};
