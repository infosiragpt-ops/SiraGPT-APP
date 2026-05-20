'use strict';

const longTermMemory = require('../services/long-term-memory');
const userMemoryStore = require('../services/user-memory-store');

function createMemoryAdapter() {
  return {
    async recall(userId, query, k) {
      return longTermMemory.recallFacts(userId, query, k);
    },
    async clear(userId) {
      return longTermMemory.clearUserMemory(userId);
    },
    async stats(userId) {
      return longTermMemory.memoryStats(userId);
    },
    capabilities() {
      return {
        pgvector: userMemoryStore.isEnabled(),
        mem0Compatible: true,
        semantic: true,
        episodic: true,
      };
    },
  };
}

module.exports = { createMemoryAdapter };
