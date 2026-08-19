'use strict';

const prisma = require('../config/database');
const { runDueSavedSearches } = require('../services/research/saved-search-alerts');

async function run(options = {}) {
  return runDueSavedSearches(options.prisma || prisma, {
    now: options.now,
    limit: options.limit,
    searchImpl: options.searchImpl,
  });
}

module.exports = { run };
