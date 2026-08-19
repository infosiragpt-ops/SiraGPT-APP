'use strict';
const { z } = require('zod');

const createChatSchema = z.object({
  title: z.string().min(1).max(200).optional().default('New Chat'),
  model: z.string().max(50).optional(),
  projectId: z.string().max(50).optional(),
});

const sendMessageSchema = z.object({
  content: z.string().min(1).max(100000),
  role: z.enum(['user']).optional().default('user'),
  files: z.array(z.object({
    id: z.string().optional(),
    name: z.string().max(200),
    mimeType: z.string().max(100).optional(),
  })).max(50).optional(),
});

module.exports = {
  createChatSchema,
  sendMessageSchema,
};
