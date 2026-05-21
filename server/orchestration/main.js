'use strict';

/**
 * server/orchestration/ — Internal orchestration layer entry point.
 *
 * All active orchestration code lives in backend/src/orchestration/.
 * This module re-exports the full surface area so that server-side
 * consumers have a single import target.
 */

module.exports = require('../../backend/src/orchestration');
