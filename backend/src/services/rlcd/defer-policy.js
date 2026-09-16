'use strict';

/**
 * Calibrated defer / abstain policy for document turns.
 *
 * Low predicted confidence → ask a clarifying question, request another
 * page/chunk, or state uncertainty instead of inventing. Capped by
 * maxDeferRate so a noisy scorer cannot turn every turn into a hedge.
 */

const { deferThreshold, maxDeferRate } = require('./flags');

const DEFER_REASONS = Object.freeze({
  BELOW_THRESHOLD: 'below_threshold',
  EXTRACTION_THIN: 'extraction_thin',
  RATE_CAPPED: 'rate_capped',
  ALREADY_HONEST: 'already_honest',
  DISABLED: 'disabled',
  OK: 'ok',
});

const HONEST_UNCERTAINTY_RE = /\b(?:no\s+(?:tengo|aparece|est[aá]|veo)\s+(?:suficiente\s+)?(?:evidencia|dato|extracto)|no\s+puedo\s+afirmar|indic(?:a|ame|as)\s+la\s+(?:secci[oó]n|p[aá]gina)|secci[oó]n\s+o\s+p[aá]gina|cannot\s+confirm|not\s+(?:enough|visible)\s+(?:evidence|in\s+the\s+extract)|which\s+(?:section|page))\b/i;

const SCARY_DEFER_RE = /\b(?:afirmar\s+esto\s+con\s+seguridad|inventar|no\s+puedo\s+afirmar|incompleto\s+para\s+afirmar)\b/i;

function decideDefer(args = {}) {
  const env = args.env || process.env;
  const confidence = Number(args.confidence);
  const threshold = Number.isFinite(args.threshold) ? args.threshold : deferThreshold(env);
  const cap = Number.isFinite(args.maxRate) ? args.maxRate : maxDeferRate(env);
  const recentRate = Number(args.recentDeferRate);
  const extractionEmpty = args.extractionEmpty === true;
  const text = String(args.text || '');

  if (!Number.isFinite(confidence)) {
    return { defer: false, reason: DEFER_REASONS.OK, threshold, cap };
  }
  if (HONEST_UNCERTAINTY_RE.test(text)) {
    return { defer: false, reason: DEFER_REASONS.ALREADY_HONEST, threshold, cap };
  }
  const below = confidence < threshold || extractionEmpty;
  if (!below) {
    return { defer: false, reason: DEFER_REASONS.OK, threshold, cap };
  }
  if (Number.isFinite(recentRate) && cap < 1 && recentRate >= cap) {
    return { defer: false, reason: DEFER_REASONS.RATE_CAPPED, threshold, cap };
  }
  return {
    defer: true,
    reason: extractionEmpty && confidence >= threshold
      ? DEFER_REASONS.EXTRACTION_THIN
      : DEFER_REASONS.BELOW_THRESHOLD,
    threshold,
    cap,
  };
}

function formatPageHint(pages, { language = 'es' } = {}) {
  const list = [...new Set((Array.isArray(pages) ? pages : []).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 3);
  if (!list.length) return '';
  const es = String(language || 'es').slice(0, 2).toLowerCase() !== 'en';
  if (list.length === 1) {
    return es ? ` ¿Es la página ${list[0]}?` : ` Is it page ${list[0]}?`;
  }
  const last = list[list.length - 1];
  const head = list.slice(0, -1).join(', ');
  return es
    ? ` ¿Es la página ${head} o la ${last}?`
    : ` Is it page ${head} or ${last}?`;
}

function buildDeferMessage({ language = 'es', reason, pages, evidence } = {}) {
  const es = String(language || 'es').slice(0, 2).toLowerCase() !== 'en';
  const hint = formatPageHint(pages || (evidence && evidence.pages), { language });
  if (reason === DEFER_REASONS.EXTRACTION_THIN || (evidence && evidence.emptyExtract)) {
    return es
      ? `El archivo aún no me da texto suficiente. ¿Puedes indicar la sección o página, o adjuntar el resto?${hint}`
      : `The file still does not give me enough text. Can you point to the section or page, or attach the rest?${hint}`;
  }
  return es
    ? `No veo ese dato con claridad en el extracto. ¿Me indicas la sección o página?${hint}`
    : `I cannot see that clearly in the extract. Can you point to the section or page?${hint}`;
}

function shouldReplaceInvented(score, evidence) {
  if (evidence && evidence.emptyExtract) return true;
  if (evidence && evidence.weakRetrieval && (evidence.coverage == null || evidence.coverage < 0.2)) {
    return true;
  }
  const claims = score && score.claims;
  if (claims && claims.n >= 1 && claims.supportRate != null && claims.supportRate < 0.35) {
    return true;
  }
  return false;
}

function compactPhrase({ language = 'es', bin } = {}) {
  const es = String(language || 'es').slice(0, 2).toLowerCase() !== 'en';
  if (bin === 'low') {
    return es
      ? '_Confianza baja: el extracto no cubre todo lo pedido._'
      : '_Low confidence: the extract does not fully cover the request._';
  }
  if (bin === 'medium') {
    return es
      ? '_Confianza media: revisa la cita antes de usarla como dato cerrado._'
      : '_Medium confidence: check the citation before treating this as settled._';
  }
  return '';
}

/**
 * Apply defer / compact phrasing. Returns the original text on any error.
 */
function applyPolicy({ text, decision, score, language, phrase } = {}) {
  try {
    const cleaned = String(text || '').trim();
    if (!cleaned) return { text: cleaned, deferred: false, phraseApplied: false };
    if (decision && decision.defer) {
      const ev = (score && score.evidence) || {};
      const pages = ev.pages || [];
      const message = buildDeferMessage({
        language,
        reason: decision.reason,
        pages,
        evidence: ev,
      });
      if (
        cleaned.length < 80
        || HONEST_UNCERTAINTY_RE.test(cleaned)
        || shouldReplaceInvented(score, ev)
      ) {
        return { text: message, deferred: true, phraseApplied: false };
      }
      return {
        text: `${message}\n\n${cleaned}`,
        deferred: true,
        phraseApplied: false,
      };
    }
    if (phrase && score && (score.bin === 'low' || score.bin === 'medium')) {
      const line = compactPhrase({ language, bin: score.bin });
      if (line && !cleaned.includes(line)) {
        return { text: `${cleaned}\n\n${line}`, deferred: false, phraseApplied: true };
      }
    }
    return { text: cleaned, deferred: false, phraseApplied: false };
  } catch {
    return { text: String(text || ''), deferred: false, phraseApplied: false };
  }
}

module.exports = {
  DEFER_REASONS,
  decideDefer,
  buildDeferMessage,
  compactPhrase,
  applyPolicy,
  formatPageHint,
  shouldReplaceInvented,
  SCARY_DEFER_RE,
};
