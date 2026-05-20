'use strict';
const { z } = require('zod');

const agentTaskSchema = z.object({
  goal: z.string().min(1).max(20000),
  model: z.string().max(100).optional(),
  maxSteps: z.number().int().min(1).max(50).optional().default(10),
  maxRuntimeMs: z.number().int().min(1000).max(600000).optional().default(120000),
  chatId: z.string().max(50).optional(),
});

const agentBatchSchema = z.object({
  tasks: z.array(agentTaskSchema).min(1).max(10),
});

module.exports = {
  agentTaskSchema,
  agentBatchSchema,
};
