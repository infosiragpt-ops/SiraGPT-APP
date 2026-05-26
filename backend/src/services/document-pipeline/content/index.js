// Single entry point for the content-generation submodule. Importers
// should require this index instead of reaching into individual files,
// so internal reorganisation stays a non-event.
const { generateSectionContent, fallbackBlock } = require('./generate-section-content');
const { createContentClient, DEFAULT_MODEL } = require('./llm-client');

module.exports = {
  generateSectionContent,
  fallbackBlock,
  createContentClient,
  DEFAULT_MODEL,
};
