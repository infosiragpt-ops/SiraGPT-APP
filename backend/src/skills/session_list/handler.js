// Thin skill wrapper around the shared session-recall service so the
// skills-registry path and the live agentic-chat tool share one
// implementation (OpenClaw `sessions_list` parity).
const { listSessions } = require('../../services/session-recall');

async function execute(args, ctx) {
  return listSessions(args || {}, ctx || {});
}

module.exports = { execute };
