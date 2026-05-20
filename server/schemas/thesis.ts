import { z } from 'zod';

export const ThesisGenerateRequestSchema = z.object({
  topic: z.string().min(3).max(5000),
  language: z.enum(['es', 'en']).optional(),
  style: z.enum(['apa', 'mla', 'chicago', 'ieee', 'vancouver']).optional(),
  depth: z.enum(['basic', 'standard', 'comprehensive']).optional(),
  chapters: z.number().int().min(3).max(20).optional(),
  includeAbstract: z.boolean().optional(),
  includeAppendices: z.boolean().optional(),
  projectId: z.string().max(128).optional(),
}).strict();

export const ThesisOutlineRequestSchema = z.object({
  topic: z.string().min(3).max(5000),
  language: z.enum(['es', 'en']).optional(),
  style: z.enum(['apa', 'mla', 'chicago', 'ieee', 'vancouver']).optional(),
  depth: z.enum(['basic', 'standard', 'comprehensive']).optional(),
}).strict();

export const ThesisSectionRequestSchema = z.object({
  thesisId: z.string().max(128),
  sectionIndex: z.number().int().min(0).max(30),
  regenerate: z.boolean().optional(),
}).strict();

export const MarcoTeoricoGenerateRequestSchema = z.object({
  projectId: z.string().min(1).max(128),
  topic: z.string().min(3).max(5000),
  sources: z.array(z.object({
    title: z.string().max(1024),
    url: z.string().url().max(2048).optional(),
    author: z.string().max(512).optional(),
    year: z.number().int().min(1500).max(2100).optional(),
    doi: z.string().max(512).optional(),
    abstract: z.string().max(10_000).optional(),
  })).max(200).optional(),
  language: z.enum(['es', 'en']).optional(),
  style: z.enum(['apa']).optional(),
}).strict();

export type ThesisGenerateRequest = z.infer<typeof ThesisGenerateRequestSchema>;
export type ThesisOutlineRequest = z.infer<typeof ThesisOutlineRequestSchema>;
export type ThesisSectionRequest = z.infer<typeof ThesisSectionRequestSchema>;
export type MarcoTeoricoGenerateRequest = z.infer<typeof MarcoTeoricoGenerateRequestSchema>;
