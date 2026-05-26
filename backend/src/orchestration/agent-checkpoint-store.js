'use strict';

function createAgentCheckpointStore({ prisma } = {}) {
  let client = prisma;

  function getPrisma() {
    if (client) return client;
    if (client === null) {
      throw new Error('agent checkpoint store requires a prisma client');
    }
    const { PrismaClient } = require('@prisma/client');
    client = new PrismaClient();
    return client;
  }

  return {
    async put({ threadId, checkpointId, parentCheckpointId = null, state = {}, metadata = {} }) {
      const db = getPrisma();
      await db.$executeRawUnsafe(
        `INSERT INTO agent_checkpoints (thread_id, checkpoint_id, parent_checkpoint_id, state, metadata)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
         ON CONFLICT (thread_id, checkpoint_id)
         DO UPDATE SET parent_checkpoint_id = EXCLUDED.parent_checkpoint_id,
                       state = EXCLUDED.state,
                       metadata = EXCLUDED.metadata`,
        threadId,
        checkpointId,
        parentCheckpointId,
        JSON.stringify(state),
        JSON.stringify(metadata),
      );
      return { threadId, checkpointId };
    },
    async get(threadId, checkpointId) {
      const db = getPrisma();
      const rows = await db.$queryRawUnsafe(
        `SELECT thread_id AS "threadId", checkpoint_id AS "checkpointId",
                parent_checkpoint_id AS "parentCheckpointId", state, metadata, created_at AS "createdAt"
         FROM agent_checkpoints
         WHERE thread_id = $1 AND checkpoint_id = $2
         LIMIT 1`,
        threadId,
        checkpointId,
      );
      return rows[0] || null;
    },
    async latest(threadId) {
      const db = getPrisma();
      const rows = await db.$queryRawUnsafe(
        `SELECT thread_id AS "threadId", checkpoint_id AS "checkpointId",
                parent_checkpoint_id AS "parentCheckpointId", state, metadata, created_at AS "createdAt"
         FROM agent_checkpoints
         WHERE thread_id = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        threadId,
      );
      return rows[0] || null;
    },
  };
}

module.exports = { createAgentCheckpointStore };
