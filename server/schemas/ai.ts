import { z } from 'zod';
import { MessagesArraySchema, FilesArraySchema } from './common.js';

export const AIGenerateRequestSchema = z.object({
  chatId: z.string().max(128).optional(),
  model: z.string().min(1).max(120).optional(),
  messages: MessagesArraySchema,
  prompt: z.string().max(200_000).optional(),
  files: FilesArraySchema,
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(200_000).optional(),
  stream: z.boolean().optional(),
  language: z.string().min(2).max(10).optional(),
  projectId: z.string().max(128).optional(),
  searchWeb: z.boolean().optional(),
  includeMemory: z.boolean().optional(),
  includeRag: z.boolean().optional(),
  context: z.record(z.any()).optional(),
}).strict();

export const AIStopStreamRequestSchema = z.object({
  chatId: z.string().max(128),
  messageId: z.string().max(128).optional(),
  streamId: z.string().max(128).optional(),
}).strict();

export const AIParaphraseRequestSchema = z.object({
  text: z.string().min(1).max(50_000),
  style: z.enum(['academic', 'professional', 'casual', 'concise', 'expanded']).optional(),
  language: z.string().min(2).max(10).optional(),
}).strict();

export const AIIntentSemanticRequestSchema = z.object({
  message: z.string().min(1).max(50_000),
  chatHistory: MessagesArraySchema.optional(),
  files: FilesArraySchema,
  projectId: z.string().max(128).optional(),
}).strict();

export const AIImageGenerateRequestSchema = z.object({
  prompt: z.string().min(1).max(4000),
  size: z.enum(['1024x1024', '1792x1024', '1024x1792']).optional(),
  quality: z.enum(['standard', 'hd']).optional(),
  style: z.enum(['vivid', 'natural']).optional(),
  model: z.string().max(120).optional(),
  n: z.number().int().min(1).max(4).optional(),
}).strict();

export const AIModelListQuerySchema = z.object({
  provider: z.string().max(64).optional(),
  capability: z.string().max(64).optional(),
  plan: z.string().max(32).optional(),
});

export type AIGenerateRequest = z.infer<typeof AIGenerateRequestSchema>;
export type AIStopStreamRequest = z.infer<typeof AIStopStreamRequestSchema>;
export type AIParaphraseRequest = z.infer<typeof AIParaphraseRequestSchema>;
export type AIIntentSemanticRequest = z.infer<typeof AIIntentSemanticRequestSchema>;
export type AIImageGenerateRequest = z.infer<typeof AIImageGenerateRequestSchema>;
export type AIModelListQuery = z.infer<typeof AIModelListQuerySchema>;
