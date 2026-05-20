import { z } from 'zod';
import {
  BaseRequestSchema,
  MessagesArraySchema,
  FilesArraySchema,
  TaskTypeSchema,
} from './common.js';

export const OrchestrationCompleteRequestSchema = BaseRequestSchema.extend({
  messages: MessagesArraySchema,
  prompt: z.string().max(200_000).optional(),
  files: FilesArraySchema,
}).strict();

export const OrchestrationEmbedRequestSchema = BaseRequestSchema.extend({
  input: z.union([
    z.string().max(200_000),
    z.array(z.string().max(200_000)).min(1).max(500),
  ]),
}).strict();

export const MemoryRecallRequestSchema = z.object({
  userId: z.string().uuid().optional(),
  query: z.string().min(1).max(10_000),
  k: z.number().int().min(1).max(20).optional(),
}).strict();

export const MemoryStoreRequestSchema = z.object({
  userId: z.string().uuid(),
  content: z.string().min(1).max(4096),
  category: z.string().max(128).optional(),
  importance: z.number().min(0).max(1).optional(),
  metadata: z.record(z.any()).optional(),
}).strict();

export const WebSearchRequestSchema = z.object({
  query: z.string().min(1).max(1000),
  maxResults: z.number().int().min(1).max(20).optional(),
}).strict();

export const LangGraphRunRequestSchema = z.object({
  threadId: z.string().min(1).max(128).optional(),
  input: z.object({
    messages: MessagesArraySchema.optional(),
    prompt: z.string().max(200_000).optional(),
    files: FilesArraySchema,
    taskType: TaskTypeSchema.optional(),
  }),
  userId: z.string().max(128),
  metadata: z.record(z.any()).optional(),
}).strict();

export const MultiAgentTeamRequestSchema = z.object({
  intent: z.string().min(1).max(5000),
  agents: z.array(z.string().min(1).max(64)).min(1).max(10).optional(),
}).strict();

export const R2UploadRequestSchema = z.object({
  userId: z.string().max(128).optional(),
  fileName: z.string().min(1).max(512),
  contentType: z.string().min(1).max(255).optional(),
  prefix: z.string().max(256).optional(),
}).strict();

export const RateLimitInfoSchema = z.object({
  provider: z.string(),
  model: z.string(),
  remaining: z.number().int().optional(),
  resetAt: z.string().datetime().optional(),
  retryAfterMs: z.number().optional(),
});

export const LLMGatewayResponseSchema = z.object({
  response: z.any(),
  provider: z.string(),
  model: z.string(),
  taskType: TaskTypeSchema,
  attempts: z.number().int().min(1),
  cached: z.boolean(),
  metrics: z.object({
    model: z.string(),
    provider: z.string(),
    tokens: z.object({
      input: z.number().int(),
      output: z.number().int(),
    }),
    costUsd: z.number(),
    latencyMs: z.number(),
    cached: z.boolean(),
  }),
});

export const LLMGatewayErrorSchema = z.object({
  error: z.string(),
  status: z.number().int(),
  causes: z.array(z.object({
    provider: z.string(),
    model: z.string(),
    message: z.string(),
    rateLimit: RateLimitInfoSchema.optional(),
  })).optional(),
});

export type OrchestrationCompleteRequest = z.infer<typeof OrchestrationCompleteRequestSchema>;
export type OrchestrationEmbedRequest = z.infer<typeof OrchestrationEmbedRequestSchema>;
export type MemoryRecallRequest = z.infer<typeof MemoryRecallRequestSchema>;
export type MemoryStoreRequest = z.infer<typeof MemoryStoreRequestSchema>;
export type WebSearchRequest = z.infer<typeof WebSearchRequestSchema>;
export type LangGraphRunRequest = z.infer<typeof LangGraphRunRequestSchema>;
export type MultiAgentTeamRequest = z.infer<typeof MultiAgentTeamRequestSchema>;
export type R2UploadRequest = z.infer<typeof R2UploadRequestSchema>;
export type LLMGatewayResponse = z.infer<typeof LLMGatewayResponseSchema>;
export type LLMGatewayError = z.infer<typeof LLMGatewayErrorSchema>;
