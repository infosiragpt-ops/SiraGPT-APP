'use strict';

/**
 * SiraCode — native coding-agent core for SiraGPT.
 *
 * Independent rewrite inspired by anomalyco/opencode (MIT). Not a vendor
 * copy and not affiliated with OpenCode or Anomaly. See NOTICE / THIRD_PARTY_NOTICES.md.
 */

const agents = require('./agents');
const permissions = require('./permissions');
const display = require('./display');
const workspace = require('./workspace');
const tools = require('./tools');
const events = require('./events');
const store = require('./session-store');
const loop = require('./loop');
const engine = require('./engine');

module.exports = {
  ...agents,
  ...permissions,
  ...display,
  ...workspace,
  ...tools,
  ...events,
  ...store,
  ...loop,
  ...engine,
};
