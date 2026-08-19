'use strict';

/**
 * Zod schemas for /api/chats and message endpoints.
 *
 * The chat domain has historically used `express-validator` checks declared
 * inline. We mirror those rules here so the contract is in one place and so
 * the FE can `z.infer` the same types via `scripts/generate-api-types.js`.
 */

const { z } = require('zod');

const CHAT_MESSAGE_ROLES = ['USER', 'ASSISTANT'];
const MAX_CHAT_TITLE_CHARS = 500;
const MAX_MODEL_ID_CHARS = 120;
const MAX_IDEMPOTENCY_KEY_CHARS = 200;
const MAX_MESSAGE_CONTENT_CHARS = (() => {
  const fromEnv = Number(process.env.SIRAGPT_MAX_MESSAGE_CHARS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 100_000;
})();

const IdempotencyKeySchema = z
  .string()
  .trim()
  .min(1, { message: 'chats.idempotency_key.required' })
  .max(MAX_IDEMPOTENCY_KEY_CHARS, { message: 'chats.idempotency_key.too_long' });

// Models accepted by /api/ai/generate — keep this list loose (any non-empty
// string up to a sane cap) because the model catalog evolves and we don't
// want a schema bump every time a new provider is added.
const ModelIdSchema = z
  .string()
  .trim()
  .min(1, { message: 'chats.model.required' })
  .max(MAX_MODEL_ID_CHARS, { message: 'chats.model.too_long' });

const CreateChatRequestSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1, { message: 'chats.title.required' })
      .max(MAX_CHAT_TITLE_CHARS, { message: 'chats.title.too_long' }),
    model: ModelIdSchema,
    isWordConnectorChat: z.boolean().optional(),
    isExcelConnectorChat: z.boolean().optional(),
    projectId: z.string().optional(),
    idempotencyKey: IdempotencyKeySchema.optional(),
  });

const MessageRoleSchema = z.enum(CHAT_MESSAGE_ROLES);

const MessageResponseSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    chatId: z.union([z.string(), z.number()]),
    role: MessageRoleSchema,
    content: z.string(),
    tokens: z.number().int().nonnegative().nullable().optional(),
    timestamp: z.union([z.string(), z.date()]).optional(),
    files: z.union([z.array(z.any()), z.string()]).nullable().optional(),
    metadata: z.union([z.record(z.any()), z.string()]).nullable().optional(),
    feedback: z.string().nullable().optional(),
  })
  .passthrough();

const ChatResponseSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    title: z.string(),
    model: z.string().nullable().optional(),
    userId: z.union([z.string(), z.number()]).optional(),
    projectId: z.string().nullable().optional(),
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
      .trim()
      .min(1, { message: 'chats.message.required' })
      .max(MAX_MESSAGE_CONTENT_CHARS, { message: 'chats.message.too_long' }),
    role: MessageRoleSchema,
    tokens: z.number().int().nonnegative().optional(),
    files: z.array(z.any()).optional(),
    metadata: z.union([z.record(z.any()), z.string()]).optional(),
    idempotencyKey: IdempotencyKeySchema.optional(),
  });

module.exports = {
  CHAT_MESSAGE_ROLES,
  MAX_CHAT_TITLE_CHARS,
  MAX_MODEL_ID_CHARS,
  MAX_IDEMPOTENCY_KEY_CHARS,
  MAX_MESSAGE_CONTENT_CHARS,
  IdempotencyKeySchema,
  ModelIdSchema,
  CreateChatRequestSchema,
  ChatResponseSchema,
  MessageResponseSchema,
  MessageRoleSchema,
  SendMessageRequestSchema,
};
