import { z } from 'zod';

export const chatCompletionSchema = z.object({
  messages: z.array(z.object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.string(),
  })),
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
  stream: z.boolean().optional(),
  model: z.string().optional(),
  taskType: z.string().optional(),
});

export const embeddingRequestSchema = z.object({
  input: z.union([z.string(), z.array(z.string())]),
  model: z.string().optional(),
});

export const searchRequestSchema = z.object({
  query: z.string().min(1),
  maxResults: z.number().optional(),
  searchDepth: z.enum(['basic', 'advanced']).optional(),
});

export const batchAnalysisSchema = z.object({
  fileIds: z.array(z.string()),
  analysisType: z.enum(['intent', 'semantic', 'deep']),
});

export type ChatCompletionRequest = z.infer<typeof chatCompletionSchema>;
export type EmbeddingRequest = z.infer<typeof embeddingRequestSchema>;
export type SearchRequest = z.infer<typeof searchRequestSchema>;
export type BatchAnalysisRequest = z.infer<typeof batchAnalysisSchema>;
