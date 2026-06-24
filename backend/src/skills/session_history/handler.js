// Thin skill wrapper around the shared session-recall service so the
// skills-registry path and the live agentic-chat tool share one
// implementation (OpenClaw `sessions_history` parity).
const { fetchSessionHistory } = require('../../services/session-recall');

async function execute(args, ctx) {
  return fetchSessionHistory(args || {}, ctx || {});
}

module.exports = { execute };
