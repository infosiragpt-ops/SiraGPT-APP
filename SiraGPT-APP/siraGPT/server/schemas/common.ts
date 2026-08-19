import { z } from 'zod';

export const MessageRoleSchema = z.enum(['user', 'assistant', 'system', 'tool']);

export const MessageSchema = z.object({
  role: MessageRoleSchema,
  content: z.string().max(200_000),
});

export const MessagesArraySchema = z.array(MessageSchema).min(1).max(200);

export const FileReferenceSchema = z.object({
  name: z.string().max(255).optional(),
  mimeType: z.string().max(255).optional(),
  content: z.string().max(2_000_000).optional(),
  url: z.string().url().max(2048).optional(),
});

export const FilesArraySchema = z.array(FileReferenceSchema).max(50).optional();

export const TaskTypeSchema = z.enum([
  'deep_reasoning',
  'speed',
  'multimodal',
  'code',
  'embeddings',
  'default',
]);

export const BaseRequestSchema = z.object({
  sessionId: z.string().min(1).max(128).optional(),
  threadId: z.string().min(1).max(128).optional(),
  model: z.string().min(1).max(120).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(200_000).optional(),
  stream: z.boolean().optional(),
  taskType: TaskTypeSchema.optional(),
});

export type MessageRole = z.infer<typeof MessageRoleSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type FileReference = z.infer<typeof FileReferenceSchema>;
export type TaskType = z.infer<typeof TaskTypeSchema>;
export type BaseRequest = z.infer<typeof BaseRequestSchema>;
