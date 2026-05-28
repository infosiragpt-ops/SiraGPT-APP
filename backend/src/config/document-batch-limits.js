'use strict';

const DEFAULT_MAX_SIMULTANEOUS_DOCUMENTS = 300;

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Product contract: SiraGPT can upload/read up to 300 documents in one batch.
// Keep this capped so one request cannot accidentally fan out thousands of
// files and overwhelm extraction, RAG indexing, or prompt planning.
const MAX_SIMULTANEOUS_DOCUMENTS = Math.min(
  DEFAULT_MAX_SIMULTANEOUS_DOCUMENTS,
  parsePositiveInt(process.env.SIRAGPT_MAX_SIMULTANEOUS_DOCUMENTS, DEFAULT_MAX_SIMULTANEOUS_DOCUMENTS),
);

module.exports = {
  DEFAULT_MAX_SIMULTANEOUS_DOCUMENTS,
  MAX_SIMULTANEOUS_DOCUMENTS,
};
