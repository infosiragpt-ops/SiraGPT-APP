'use strict';

/**
 * Thin wrapper so `npm test` inside services/computer/orchestrator also
 * covers the in-image agent helpers.
 */
require('../../../backend/tests/agent-computer-agent.test.js');
