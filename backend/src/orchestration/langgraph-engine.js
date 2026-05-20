'use strict';

const crypto = require('crypto');
const { createAgentCheckpointStore } = require('./agent-checkpoint-store');

function checkpointId() {
  return `ckpt_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function createLangGraphOrchestrator({ checkpointStore = createAgentCheckpointStore(), gateway } = {}) {
  const nodes = ['planner', 'retriever', 'tool-executor', 'critic', 'synthesizer', 'finalizer'];
  return {
    nodes,
    async run({ threadId, input, userId, metadata = {} }) {
      const state = {
        input,
        userId,
        plan: null,
        retrieval: [],
        toolResults: [],
        critique: null,
        answer: null,
      };
      state.plan = { steps: ['retrieve', 'synthesize', 'finalize'], intent: metadata.intent || 'chat' };
      await checkpointStore.put({ threadId, checkpointId: checkpointId(), state, metadata: { ...metadata, node: 'planner' } });
      state.retrieval = metadata.retrieval || [];
      await checkpointStore.put({ threadId, checkpointId: checkpointId(), state, metadata: { ...metadata, node: 'retriever' } });
      state.toolResults = metadata.toolResults || [];
      state.critique = { safe: true, needsRevision: false };
      if (gateway && input?.messages) {
        const result = await gateway.complete({ messages: input.messages, prompt: input.prompt, files: input.files });
        state.answer = result.response?.choices?.[0]?.message?.content || '';
        state.model = { provider: result.provider, model: result.model };
      }
      await checkpointStore.put({ threadId, checkpointId: checkpointId(), state, metadata: { ...metadata, node: 'finalizer' } });
      return state;
    },
  };
}

module.exports = { createLangGraphOrchestrator };
