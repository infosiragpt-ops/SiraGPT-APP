import { z } from 'zod';

export const projectCreateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  instructions: z.string().optional(),
});

export const projectUpdateSchema = projectCreateSchema.partial();

export const shareSchema = z.object({
  chatId: z.string(),
  recipientId: z.string().optional(),
  publicAccess: z.boolean().optional(),
});

export type ProjectCreate = z.infer<typeof projectCreateSchema>;
export type ProjectUpdate = z.infer<typeof projectUpdateSchema>;
export type Share = z.infer<typeof shareSchema>;
