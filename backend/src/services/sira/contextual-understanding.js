'use strict';

const {
  resolveCoreferences,
  buildCorefPromptBlock,
} = require('../agents/coref-resolver');
const personalLexicon = require('../personal-lexicon');
const conversationRepair = require('../agents/conversation-repair');
const misunderstandingSignals = require('../agents/misunderstanding-signals');

const MAX_RECENT_TURNS = 8;
const MAX_EFFECTIVE_TEXT = 8000;
const DEFAULT_COREF_TIMEOUT_MS = 250;

function clampText(value, max = 500) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function textFromHistoryItem(item) {
  if (!item || typeof item !== 'object') return '';
  const content = item.content;
  if (typeof item.text === 'string') return item.text;
  if (typeof content === 'string') return content;
  if (content && typeof content.text === 'string') return content.text;
  if (content && typeof content.original === 'string') return content.original;
  try {
    return content ? JSON.stringify(content) : '';
  } catch {
    return '';
  }
}

function normalizeRecentTurns(history = [], maxTurns = MAX_RECENT_TURNS) {
  if (!Array.isArray(history)) return [];
  const out = [];
  for (const item of history) {
    const role = item?.role === 'assistant' ? 'assistant' : item?.role === 'user' ? 'user' : null;
    if (!role) continue;
    const text = textFromHistoryItem(item).trim();
    if (!text) continue;
    out.push({ role, text });
  }
  return out.slice(-maxTurns);
}

function findPreviousTurn(recentTurns, role) {
  for (let i = recentTurns.length - 1; i >= 0; i -= 1) {
    if (recentTurns[i]?.role === role) return recentTurns[i];
  }
  return null;
}

function summarizeCoreference(coref) {
  const refs = Array.isArray(coref?.references) ? coref.references : [];
  return {
    source: coref?.source || 'not_run',
    latency_ms: Number.isFinite(coref?.latencyMs) ? coref.latencyMs : 0,
    references: refs.slice(0, 5).map((ref) => ({
      span: clampText(ref.span || ref.anaphor, 80),
      resolves_to: ref.resolvesTo ? clampText(ref.resolvesTo, 240) : null,
      confidence: typeof ref.confidence === 'number' ? ref.confidence : 0,
      source: ref.source || null,
    })),
  };
}

function summarizeLexiconTerms(terms = []) {
  if (!Array.isArray(terms)) return [];
  return terms.slice(0, 5).map((term) => ({
    term: clampText(term.term, 120),
    definition: clampText(term.definition, 300),
    confidence: typeof term.confidence === 'number' ? term.confidence : 0,
    hits: Number.isFinite(term.hits) ? term.hits : 0,
  }));
}

function summarizeRepair(detection, repairContext) {
  if (!detection?.isRepair) {
    return { is_repair: false, repair_type: null, contract_override: null };
  }
  return {
    is_repair: true,
    repair_type: detection.repairType || null,
    evidence: clampText(detection.evidence, 100),
    contract_override: repairContext?.contractOverride || null,
  };
}

function buildEffectiveText({
  originalText,
  corefBlock,
  lexiconBlock,
  repairAddendum,
  resolvedPrompt,
}) {
  const basePrompt = String(resolvedPrompt || originalText || '').trim();
  const blocks = [corefBlock, lexiconBlock, repairAddendum]
    .filter((block) => typeof block === 'string' && block.trim().length > 0);
  if (blocks.length === 0 || basePrompt.length === 0) return basePrompt;
  const effective = `${blocks.join('\n\n')}\n\nSOLICITUD_USUARIO:\n${basePrompt}`;
  return effective.length > MAX_EFFECTIVE_TEXT
    ? `${effective.slice(0, MAX_EFFECTIVE_TEXT - 3)}...`
    : effective;
}

async function safeLookupTerms(lexicon, { userId, prompt }) {
  if (!lexicon || typeof lexicon.lookupTerms !== 'function') return [];
  try {
    const terms = await lexicon.lookupTerms({ userId, prompt, k: 5 });
    return Array.isArray(terms) ? terms : [];
  } catch {
    return [];
  }
}

async function analyzeContextualTurn({
  userId,
  conversationId,
  userMessage,
  history = [],
  attachments = [],
  requestId = null,
} = {}, deps = {}) {
  const originalText = String(userMessage || '');
  const recentTurns = normalizeRecentTurns(history);
  const lexicon = deps.lexicon || personalLexicon;
  const corefResolver = deps.corefResolver || { resolveCoreferences, buildCorefPromptBlock };
  const repair = deps.repair || conversationRepair;
  const signals = deps.signals || misunderstandingSignals;

  try {
    const coref = await corefResolver.resolveCoreferences({
      prompt: originalText,
      recentTurns,
      attachments,
      judge: deps.corefJudge || null,
      options: { timeoutMs: deps.corefTimeoutMs || DEFAULT_COREF_TIMEOUT_MS },
    });
    const corefBlock = typeof corefResolver.buildCorefPromptBlock === 'function'
      ? corefResolver.buildCorefPromptBlock(coref.references || [])
      : null;

    const lexiconTerms = await safeLookupTerms(lexicon, { userId, prompt: originalText });
    const lexiconBlock = typeof lexicon.buildLexiconBlock === 'function'
      ? lexicon.buildLexiconBlock(lexiconTerms)
      : null;

    const prevAssistant = findPreviousTurn(recentTurns, 'assistant');
    const prevUser = findPreviousTurn(recentTurns, 'user');
    const signalSummary = userId && typeof signals.aggregateByUser === 'function'
      ? signals.aggregateByUser(userId)
      : null;
    const repairDetection = repair.detectRepair({
      prompt: originalText,
      prevTurn: prevAssistant,
      prevUserPrompt: prevUser?.text || null,
      signals: signalSummary,
    });
    const repairContext = repair.buildRepairContext(repairDetection);

    const recordedSignals = typeof signals.recordFromContext === 'function'
      ? signals.recordFromContext({
        userId,
        sessionId: conversationId,
        turnId: requestId,
        currentPrompt: originalText,
        previousPrompt: prevUser?.text || null,
        msSincePrevious: recentTurns.length > 0 ? 1000 : null,
      })
      : [];

    const effectiveText = buildEffectiveText({
      originalText,
      corefBlock,
      lexiconBlock,
      repairAddendum: repairContext.systemAddendum,
      resolvedPrompt: coref.resolvedPrompt || originalText,
    });
    const applied = effectiveText !== originalText;

    const envelopeContext = {
      applied,
      original_text: originalText,
      effective_text: effectiveText,
      recent_turn_count: recentTurns.length,
      coreference: summarizeCoreference(coref),
      lexicon_terms: summarizeLexiconTerms(lexiconTerms),
      repair: summarizeRepair(repairDetection, repairContext),
      misunderstanding_signals: recordedSignals,
    };

    return {
      applied,
      originalText,
      effectiveText,
      recentTurns,
      coreference: coref,
      lexiconTerms,
      repairDetection,
      repairContext,
      misunderstandingSignals: recordedSignals,
      envelopeContext,
      error: null,
    };
  } catch (error) {
    return {
      applied: false,
      originalText,
      effectiveText: originalText,
      recentTurns,
      coreference: null,
      lexiconTerms: [],
      repairDetection: { isRepair: false },
      repairContext: { systemAddendum: null, contractOverride: null },
      misunderstandingSignals: [],
      envelopeContext: {
        applied: false,
        original_text: originalText,
        effective_text: originalText,
        recent_turn_count: recentTurns.length,
        coreference: { source: 'error', latency_ms: 0, references: [] },
        lexicon_terms: [],
        repair: { is_repair: false, repair_type: null, contract_override: null },
        misunderstanding_signals: [],
      },
      error: error && error.message ? error.message : String(error),
    };
  }
}

module.exports = {
  analyzeContextualTurn,
  normalizeRecentTurns,
  textFromHistoryItem,
  findPreviousTurn,
  buildEffectiveText,
  summarizeCoreference,
  summarizeLexiconTerms,
  summarizeRepair,
  constants: {
    MAX_RECENT_TURNS,
    MAX_EFFECTIVE_TEXT,
    DEFAULT_COREF_TIMEOUT_MS,
  },
};
