import { z } from 'zod';

export const ScientificSearchRequestSchema = z.object({
  query: z.string().min(1).max(5000),
  maxResults: z.number().int().min(1).max(100).optional(),
  sources: z.array(z.enum([
    'arxiv',
    'openalex',
    'crossref',
    'europepmc',
    'semantic_scholar',
    'pubmed',
    'core',
  ])).max(7).optional(),
  yearFrom: z.number().int().min(1900).max(2100).optional(),
  yearTo: z.number().int().min(1900).max(2100).optional(),
  language: z.string().max(10).optional(),
}).strict();

export const ResearchAgentRunRequestSchema = z.object({
  topic: z.string().min(3).max(5000),
  depth: z.enum(['quick', 'standard', 'deep']).optional(),
  model: z.string().max(120).optional(),
  language: z.string().min(2).max(10).optional(),
  maxPages: z.number().int().min(1).max(20).optional(),
  includeVision: z.boolean().optional(),
  stream: z.boolean().optional(),
}).strict();

export const ResearchAgentStreamParamsSchema = z.object({
  topic: z.string().min(3).max(5000),
  depth: z.enum(['quick', 'standard', 'deep']).optional(),
  model: z.string().max(120).optional(),
  language: z.string().min(2).max(10).optional(),
  maxPages: z.number().int().min(1).max(20).optional(),
  includeVision: z.boolean().optional(),
});

export type ScientificSearchRequest = z.infer<typeof ScientificSearchRequestSchema>;
export type ResearchAgentRunRequest = z.infer<typeof ResearchAgentRunRequestSchema>;
export type ResearchAgentStreamParams = z.infer<typeof ResearchAgentStreamParamsSchema>;
