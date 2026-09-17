'use strict';

/**
 * Trivial chat turns (hola, hi, ok, gracias…) must stay on the direct path.
 * Shared by generate, thinking controls, and SiraCode so Construir/Planificar
 * cannot start a tool loop for a greeting.
 *
 * The §3.1 precedence table lives in turn-router.js. This module stays the
 * R_TRIVIAL helper used by #506 callers (text-only) and re-exports the router.
 */

const { isShortChitchatPrompt } = require('./agents/intent-triage');
const {
  routeTurn,
  extractSignalsFromReq,
  isTrivialPhrase,
  allowsSiraCode,
  applyTurnRouterGuards,
  isTrivialDecision,
} = require('./turn-router');

function isTrivialChatTurn(text, signals) {
  if (signals && typeof signals === 'object') {
    return routeTurn({ text, ...signals }).trivial === true;
  }
  return isTrivialPhrase(text) || isShortChitchatPrompt(text);
}

function shouldForceDirectMode(text, signals) {
  return isTrivialChatTurn(text, signals);
}

function shouldStartSiraCodeRun(text, signals) {
  return allowsSiraCode({ text, ...(signals && typeof signals === 'object' ? signals : {}) });
}

function resolveThinkingLevelForTurn({ thinkingLevel, userPrompt, fallback } = {}) {
  if (thinkingLevel != null && String(thinkingLevel).trim()) {
    return String(thinkingLevel).trim();
  }
  if (isTrivialChatTurn(userPrompt)) return 'disabled';
  return fallback || 'high';
}

function applyTrivialTurnGuards(req, prompt) {
  const routed = applyTurnRouterGuards(req, prompt);
  const trivial = isTrivialDecision(routed);
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
  routeTurn,
  extractSignalsFromReq,
};
