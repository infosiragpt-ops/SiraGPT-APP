'use strict';

/**
 * Zod schemas for /api/chats and message endpoints.
 *
 * The chat domain has historically used `express-validator` checks declared
 * inline. We mirror those rules here so the contract is in one place and so
 * the FE can `z.infer` the same types via `scripts/generate-api-types.js`.
 */

const { z } = require('zod');

// Models accepted by /api/ai/generate — keep this list loose (any non-empty
// string up to a sane cap) because the model catalog evolves and we don't
// want a schema bump every time a new provider is added.
const ModelIdSchema = z
  .string()
  .trim()
  .min(1, { message: 'chats.model.required' })
  .max(120, { message: 'chats.model.too_long' });

const CreateChatRequestSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1, { message: 'chats.title.required' })
      .max(500, { message: 'chats.title.too_long' }),
    model: ModelIdSchema,
    isWordConnectorChat: z.boolean().optional(),
    isExcelConnectorChat: z.boolean().optional(),
    projectId: z
      .union([z.string(), z.number()])
      .optional(),
  })
  .strict();

const MessageRoleSchema = z.enum(['user', 'assistant', 'system', 'tool']);

const MessageResponseSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    chatId: z.union([z.string(), z.number()]),
    role: MessageRoleSchema,
    content: z.string(),
    model: z.string().nullable().optional(),
    createdAt: z.union([z.string(), z.date()]).optional(),
    updatedAt: z.union([z.string(), z.date()]).optional(),
    metadata: z.record(z.any()).nullable().optional(),
    attachments: z.array(z.any()).optional(),
    feedback: z.string().nullable().optional(),
  })
  .passthrough();

const ChatResponseSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    title: z.string(),
    model: z.string().nullable().optional(),
    userId: z.union([z.string(), z.number()]).optional(),
    projectId: z.union([z.string(), z.number()]).nullable().optional(),
    isWordConnectorChat: z.boolean().optional(),
    isExcelConnectorChat: z.boolean().optional(),
    createdAt: z.union([z.string(), z.date()]).optional(),
    updatedAt: z.union([z.string(), z.date()]).optional(),
    messages: z.array(MessageResponseSchema).optional(),
  })
  .passthrough();

const SendMessageRequestSchema = z
  .object({
    content: z
      .string()
      .min(1, { message: 'chats.message.required' })
      .max(200000, { message: 'chats.message.too_long' }),
    role: MessageRoleSchema.optional(),
    model: ModelIdSchema.optional(),
    attachments: z.array(z.any()).optional(),
  })
  .strict();

module.exports = {
  ModelIdSchema,
  CreateChatRequestSchema,
  ChatResponseSchema,
  MessageResponseSchema,
  MessageRoleSchema,
  SendMessageRequestSchema,
};
