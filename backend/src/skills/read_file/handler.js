/**
 * read_file — read a source from the user's RAG collection.
 *
 * Delegates to the existing agent-tools.read_file implementation so the
 * language-aware chunk separators and size clamping stay consistent
 * across both the new skills-registry path and the legacy agent-tools
 * array. Single source of truth for the logic, skill format for
 * discovery.
 *
 * Note: this reads from the RAG collection, not the host filesystem.
 * siraGPT never exposes host files to agents.
 */

const agentTools = require('../../services/agents/agent-tools');

async function execute(args, ctx) {
  return agentTools.read_file.handler(args, ctx);
}

module.exports = { execute };
