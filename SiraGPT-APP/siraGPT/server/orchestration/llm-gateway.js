'use strict';

/**
 * server/orchestration/llm-gateway.js
 * 
 * Thin re-export from the canonical implementation at
 * backend/src/orchestration/llm-gateway.js.
 * 
 * This file exists so that any code importing from
 * server/orchestration/ resolves to the same module as
 * backend/src/orchestration/, maintaining a single source of
 * truth while supporting both import paths.
 */

module.exports = require('../../backend/src/orchestration/llm-gateway');
