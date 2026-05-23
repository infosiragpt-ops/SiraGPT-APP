/**
 * SearchBrain — public entrypoint. Everything downstream imports from
 * this file so internal module restructures stay invisible.
 */

const { runSearchBrain } = require("./orchestrator");
const { projectForChat, toCitation, buildPromptInjection } = require("./chatAdapter");
const { retrieveFromProvider } = require("./providers");
const { callLLM } = require("./llmClient");
const { DEFAULT_ACADEMIC_SOURCES, DEFAULT_WEIGHTS } = require("./types");

/**
 * Production entrypoint. Wires the default LLM callable + provider
 * retriever; tests pass their own via `options.deps`.
 *
 * @param {object} options
 * @returns {Promise<import("./types").SearchBrainResponse>}
 */
async function searchAcademic(options) {
  const deps = options.deps || {};
  return runSearchBrain({
    ...options,
    deps: {
      callLLM: deps.callLLM ?? callLLM,
      retrieve: deps.retrieve ?? retrieveFromProvider,
      now: deps.now,
    },
  });
}

/**
 * Run the pipeline and immediately project for the chat surface —
 * returns { response, citations, promptInjection, providersUsed }.
 */
async function searchAcademicForChat(options) {
  const response = await searchAcademic(options);
  const projected = projectForChat(response);
  return {
    response,
    citations: projected.citations,
    promptInjection: projected.promptInjection,
    providersUsed: projected.providersUsed,
  };
}

module.exports = {
  searchAcademic,
  searchAcademicForChat,
  runSearchBrain,
  retrieveFromProvider,
  toCitation,
  buildPromptInjection,
  DEFAULT_ACADEMIC_SOURCES,
  DEFAULT_WEIGHTS,
};
