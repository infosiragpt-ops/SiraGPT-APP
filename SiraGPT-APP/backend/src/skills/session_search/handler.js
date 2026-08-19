const { searchSessions } = require('../../services/session-search');

async function execute(args, ctx) {
  return searchSessions(args || {}, ctx || {});
}

module.exports = { execute };
