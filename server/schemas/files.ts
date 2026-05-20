import { z } from 'zod';

export const FileUploadQuerySchema = z.object({
  projectId: z.string().max(128).optional(),
  chatId: z.string().max(128).optional(),
  analyze: z.string().optional(),
  language: z.string().max(10).optional(),
});

export const FileProcessRequestSchema = z.object({
  fileId: z.string().max(128),
  extractTables: z.boolean().optional(),
  extractReferences: z.boolean().optional(),
  extractEntities: z.boolean().optional(),
  analyzeDomain: z.boolean().optional(),
  riskAssessment: z.boolean().optional(),
  language: z.string().max(10).optional(),
}).strict();

export const FileQuerySchema = z.object({
  fileId: z.string().max(128),
  query: z.string().min(1).max(5000),
  k: z.number().int().min(1).max(20).optional(),
  includeContext: z.boolean().optional(),
}).strict();

export const BatchFileProcessRequestSchema = z.object({
  fileIds: z.array(z.string().max(128)).min(1).max(50),
  extractTables: z.boolean().optional(),
  extractReferences: z.boolean().optional(),
  crossDocumentAnalysis: z.boolean().optional(),
  language: z.string().max(10).optional(),
}).strict();

export const CoworkAutoFileRequestSchema = z.object({
  content: z.string().min(200).max(2_000_000),
  fileName: z.string().max(512).optional(),
  mimeType: z.string().max(255).optional(),
  chatId: z.string().max(128).optional(),
  projectId: z.string().max(128).optional(),
}).strict();

export const CoworkDeepAnalyzeRequestSchema = z.object({
  fileId: z.string().max(128),
  analyzeDomain: z.boolean().optional(),
  extractPii: z.boolean().optional(),
  riskAssessment: z.boolean().optional(),
  qualityMetrics: z.boolean().optional(),
}).strict();

export type FileUploadQuery = z.infer<typeof FileUploadQuerySchema>;
export type FileProcessRequest = z.infer<typeof FileProcessRequestSchema>;
export type FileQuery = z.infer<typeof FileQuerySchema>;
export type BatchFileProcessRequest = z.infer<typeof BatchFileProcessRequestSchema>;
export type CoworkAutoFileRequest = z.infer<typeof CoworkAutoFileRequestSchema>;
export type CoworkDeepAnalyzeRequest = z.infer<typeof CoworkDeepAnalyzeRequestSchema>;
