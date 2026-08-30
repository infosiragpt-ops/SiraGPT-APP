'use strict';

/**
 * Trivial chat turns (hola, hi, ok, gracias…) must stay on the direct path.
 * Shared by generate, thinking controls, and SiraCode so Construir/Planificar
 * cannot start a tool loop for a greeting.
 */

const { isShortChitchatPrompt } = require('./agents/intent-triage');

function isTrivialChatTurn(text) {
  return isShortChitchatPrompt(text);
}

function shouldForceDirectMode(text) {
  return isTrivialChatTurn(text);
}

function shouldStartSiraCodeRun(text) {
  return !isTrivialChatTurn(text);
}

function resolveThinkingLevelForTurn({ thinkingLevel, userPrompt, fallback } = {}) {
  if (thinkingLevel != null && String(thinkingLevel).trim()) {
    return String(thinkingLevel).trim();
  }
  if (isTrivialChatTurn(userPrompt)) return 'disabled';
  return fallback || 'high';
}

function applyTrivialTurnGuards(req, prompt) {
  const trivial = isTrivialChatTurn(prompt);
  if (!req || typeof req !== 'object') return trivial;
  req._trivialTurn = trivial;
  if (trivial) {
    req.body = req.body && typeof req.body === 'object' ? req.body : {};
    req.body.disableAgentic = true;
    req._thinkingLevel = 'disabled';
  }
  return trivial;
}

module.exports = {
  isTrivialChatTurn,
  shouldForceDirectMode,
  shouldStartSiraCodeRun,
  resolveThinkingLevelForTurn,
  applyTrivialTurnGuards,
};
