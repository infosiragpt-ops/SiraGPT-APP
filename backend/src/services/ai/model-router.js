'use strict';

/**
 * model-router.js — Prompt-aware model selection optimizer.
 *
 *   pickModel({ prompt, userPreference, contextSize, attachments })
 *     → { model, reason, signals }
 *
 * The router is deterministic + pure (no I/O, no LLM) so it's safe to
 * call inline on every request. If the user has set an explicit
 * preference (e.g. via UI dropdown), we honor it as-is and surface a
 * `reason: 'user_preference'`. Otherwise, we heuristically classify
 * prompt complexity, language, modality and pick the most cost-
 * effective model that's still capable of handling the task.
 *
 * This module is NOT wired into the request path yet — Task 2 only
 * asks that we provide it. Routes can opt-in later via:
 *
 *   const { pickModel } = require('./ai/model-router');
 *   const choice = pickModel({ prompt, userPreference, contextSize });
 */

const CODE_PATTERNS = [
    /```/, /\bfunction\b/, /\bclass\b/, /=>/, /\bconst\b/, /\blet\b/,
    /\bimport\b/, /\bexport\b/, /\bdef\b/, /\breturn\b/, /<\/?[a-z][\s\S]*?>/i,
];

const COMPLEXITY_HINTS = [
    /\banaliza|analyze|deep\b/i,
    /\bcompare|comparativa|contrasta\b/i,
    /\bexplica detalladamente|explain in detail|step by step|paso a paso\b/i,
    /\bresearch|investiga|investigación\b/i,
    /\bprueba|prove|demuestra\b/i,
    /\bdiseña|architect|arquitectura|design.*system\b/i,
    /\brefactor|optimize|optimiza\b/i,
];

const TRIVIAL_HINTS = [
    /^(hola|hi|hello|hey|buenas|buenos d[ií]as|qué tal|hi there|gracias|thanks|ok|vale|s[ií]|no)\b/i,
    /^(¿)?(cómo|how) (est[áa]s|are you)/i,
];

/**
 * Quick language detector — Spanish vs English vs Portuguese vs French
 * vs German vs Italian. Returns ISO code or 'unknown'. Heuristic only;
 * good enough for routing decisions (final language is decided by
 * lang-policy elsewhere).
 */
function detectLanguage(text) {
    if (!text || typeof text !== 'string') return 'unknown';
    const t = text.toLowerCase();
    const scores = {
        es: 0, en: 0, pt: 0, fr: 0, de: 0, it: 0,
    };
    // Spanish markers
    if (/[áéíóúñü¿¡]/.test(t)) scores.es += 2;
    if (/\b(el|la|los|las|de|que|y|es|son|por|para|pero|también|cuando|cómo)\b/.test(t)) scores.es += 1;
    // English markers
    if (/\b(the|of|and|to|is|are|for|with|but|this|that|when|how)\b/.test(t)) scores.en += 1;
    // Portuguese markers
    if (/\b(é|são|você|não|também|português|obrigado)\b/.test(t)) scores.pt += 1;
    if (/\bção\b|ções\b|nho\b|nha\b/.test(t)) scores.pt += 1;
    // French markers
    if (/\b(le|la|les|de|et|est|sont|pour|avec|mais|comment|aussi)\b/.test(t)) scores.fr += 1;
    if (/[çœèêëà]/.test(t)) scores.fr += 1;
    // German markers
    if (/\b(der|die|das|und|ist|sind|für|mit|aber|wie|auch)\b/.test(t)) scores.de += 1;
    if (/[äöüß]/.test(t)) scores.de += 1;
    // Italian markers
    if (/\b(il|lo|la|gli|le|di|che|è|sono|per|con|ma|come|anche)\b/.test(t)) scores.it += 1;
    const top = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
    return top && top[1] > 0 ? top[0] : 'unknown';
}

/**
 * Estimate prompt complexity given the prompt text + context size +
 * attachments. Result is a deterministic score ∈ [0,1] alongside a
 * categorical bucket: trivial / simple / moderate / complex.
 */
function estimateComplexity({ prompt, contextSize = 0, attachments = [] }) {
    const text = typeof prompt === 'string' ? prompt : '';
    const len = text.length;
    const lineCount = (text.match(/\n/g) || []).length + 1;
    const hasCode = CODE_PATTERNS.some(rx => rx.test(text));
    const hasComplexity = COMPLEXITY_HINTS.some(rx => rx.test(text));
    const isTrivial = TRIVIAL_HINTS.some(rx => rx.test(text)) && len < 80;
    const att = Array.isArray(attachments) ? attachments.length : 0;

    let score = 0;
    score += Math.min(0.30, len / 4000);             // length
    score += Math.min(0.10, lineCount / 50);          // multi-line
    score += hasCode ? 0.20 : 0;
    score += hasComplexity ? 0.25 : 0;
    score += att > 0 ? Math.min(0.15, att * 0.05) : 0;
    score += Math.min(0.20, contextSize / 50000);     // multi-turn context
    if (isTrivial) score = Math.min(score, 0.05);
    score = Math.max(0, Math.min(1, score));

    let bucket;
    if (isTrivial || score < 0.15) bucket = 'trivial';
    else if (score < 0.35) bucket = 'simple';
    else if (score < 0.65) bucket = 'moderate';
    else bucket = 'complex';

    return { score, bucket, hasCode, hasComplexity, isTrivial, length: len, lineCount, attachments: att, contextSize };
}

/**
 * Pick the best model based on prompt complexity. Honors explicit
 * user preference. Returns a structured choice including a human-
 * readable reason for logging / observability.
 */
function pickModel({ prompt = '', userPreference = null, contextSize = 0, attachments = [] } = {}) {
    if (userPreference && typeof userPreference === 'string' && userPreference.trim()) {
        return {
            model: userPreference.trim(),
            reason: 'user_preference',
            signals: { userPreference: userPreference.trim() },
        };
    }

    const complexity = estimateComplexity({ prompt, contextSize, attachments });
    const language = detectLanguage(prompt);
    const hasImages = Array.isArray(attachments) && attachments.some(a => {
        const mime = a && (a.mimeType || a.mime || a.type);
        return typeof mime === 'string' && mime.startsWith('image/');
    });

    // Vision needed → bias toward gpt-4o family (broad vision support).
    if (hasImages) {
        if (complexity.bucket === 'complex') {
            return { model: 'gpt-4o', reason: 'vision+complex', signals: { ...complexity, language, hasImages } };
        }
        return { model: 'gpt-4o-mini', reason: 'vision', signals: { ...complexity, language, hasImages } };
    }

    // Massive context — prefer long-context models
    if (contextSize > 80_000) {
        return { model: 'gemini-2.5-pro', reason: 'long_context', signals: { ...complexity, language, hasImages } };
    }

    switch (complexity.bucket) {
        case 'trivial':
            return { model: 'gpt-4o-mini', reason: 'trivial_prompt', signals: { ...complexity, language, hasImages } };
        case 'simple':
            return { model: 'gpt-4o-mini', reason: 'simple_prompt', signals: { ...complexity, language, hasImages } };
        case 'moderate':
            return { model: complexity.hasCode ? 'gpt-4o' : 'gpt-4o', reason: 'moderate_prompt', signals: { ...complexity, language, hasImages } };
        case 'complex':
        default:
            return {
                model: complexity.hasCode ? 'claude-sonnet-4.5' : 'gpt-4.1',
                reason: 'complex_prompt',
                signals: { ...complexity, language, hasImages },
            };
    }
}

module.exports = {
    pickModel,
    detectLanguage,
    estimateComplexity,
};
