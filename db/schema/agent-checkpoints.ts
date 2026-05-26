import { pgTable, text, jsonb, timestamp, primaryKey } from 'drizzle-orm/pg-core';

export const agentCheckpoints = pgTable('agent_checkpoints', {
  threadId: text('thread_id').notNull(),
  checkpointId: text('checkpoint_id').notNull(),
  parentCheckpointId: text('parent_checkpoint_id'),
  state: jsonb('state').notNull().default('{}'),
  metadata: jsonb('metadata').notNull().default('{}'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.threadId, table.checkpointId] }),
}));
