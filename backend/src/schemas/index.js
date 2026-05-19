'use strict';

/**
 * Barrel export for backend zod schemas.
 *
 * `scripts/generate-api-types.js` walks every named export found here and
 * emits a matching TypeScript type into `lib/api-types.ts`, so anything new
 * must be exported through this file to show up on the FE.
 */

const auth = require('./auth');
const chats = require('./chats');
const files = require('./files');
const payments = require('./payments');
const orgs = require('./orgs');

module.exports = {
  ...auth,
  ...chats,
  ...files,
  ...payments,
  ...orgs,
};
