'use strict';

const INJECTION_PATTERNS = [
  /ignore\s+(?:all\s+)?(?:previous|above)\s+(?:instructions?|prompts?|directions?|guidelines?|rules?)/i,
  /forget\s+(?:all\s+)?(?:your\s+)?(?:previous\s+)?(?:instructions?|prompts?|training|context|rules?)/i,
  /you\s+(?:are|now)\s+(?:now\s+)?(?:a\s+)?(?:different\s+)?(?:assistant|ai|bot|model|persona|character)/i,
  /system\s*:\s*\n/i,
  /<\|im_start\|>/i,
  /<\|im_end\|>/i,
  /\[INST\]/i,
  /\[\/INST\]/i,
  /\[SYSTEM\]/i,
  /\[\/SYSTEM\]/i,
  /<<SYS>>/i,
  /<<\/SYS>>/i,
  /from\s+now\s+on\s+(?:you\s+)?(?:are|will|respond|act|speak|behave)/i,
  /override\s+(?:the\s+)?(?:system|instructions?|prompts?|rules?|safety)/i,
  /bypass\s+(?:the\s+)?(?:system|instructions?|safety|filter|moderation|guardrails?)/i,
  /disable\s+(?:the\s+)?(?:system|instructions?|safety|filter|moderation|guardrails?)/i,
  /jailbreak/i,
  /dan\s*(?:mode|prompt|jailbreak)/i,
  /developer\s*mode/i,
  /token\s*(?:smuggling|injection|leak|extraction)/i,
  /reveal\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions?|rules?|guidelines?|internal)/i,
  /what\s+(?:does|do|is|are)\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions?|rules?|guidelines?)\s*(?:\?|look|say)/i,
  /show\s+(?:me\s+)?(?:your\s+)?(?:system\s+)?(?:prompt|instructions?|rules?|guidelines?|internal)/i,
  /print\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions?|rules?|guidelines?|internal)/i,
  /begin\s+by\s+outputting\s+your\s+(?:system\s+)?(?:prompt|instructions?|rules?)/i,
  /start\s+your\s+response\s+with/i,
  /respond\s+(?:only\s+)?(?:with|using|in|as)/i,
  /do\s+not\s+(?:follow|obey)\s+(?:your\s+)?(?:system|instructions?|rules?|guidelines?)/i,
  /you\s+are\s+no\s+longer/i,
  /new\s+(?:system\s+)?(?:prompt|instructions?|rules?)\s*(?::|is|are|as\s+follows)/i,
  /your\s+(?:new|updated|revised)\s+(?:system\s+)?(?:prompt|instructions?|rules?)/i,
  /act\s+as\s+(?:if\s+)?(?:you\s+(?:are|were)|an?\s+unfiltered)/i,
  /without\s+(?:any\s+)?(?:restrictions?|limitations?|constraints?|rules?|guidelines?|ethics?|morals?)/i,
  /no\s+(?:restrictions?|limitations?|constraints?|rules?|ethics?|morals?|filters?)/i,
  /\bprompt\s*injection\b/i,
  /repeat\s+(?:after\s+me|the\s+following|this\s+exact)/i,
  /output\s+(?:exactly|precisely)\s+(?:what|as)/i,
];

const SEVERITY_THRESHOLDS = Object.freeze({
  low: 1,
  medium: 3,
  high: 6,
  critical: 10,
});

function scoreInjectionRisk(text = '') {
  if (typeof text !== 'string' || !text.trim()) {
    return { score: 0, severity: 'none', matches: [] };
  }

  const matches = [];
  let score = 0;

  for (const pattern of INJECTION_PATTERNS) {
    const result = pattern.exec(text);
    if (result) {
      matches.push({ pattern: pattern.source.slice(0, 80), match: result[0].slice(0, 100) });
      score += 1;
    }
  }

  let severity = 'none';
  if (score >= SEVERITY_THRESHOLDS.critical) severity = 'critical';
  else if (score >= SEVERITY_THRESHOLDS.high) severity = 'high';
  else if (score >= SEVERITY_THRESHOLDS.medium) severity = 'medium';
  else if (score >= SEVERITY_THRESHOLDS.low) severity = 'low';

  return { score, severity, matches };
}

function blockThreshold(env = process.env) {
  const configured = env.SIRAGPT_PROMPT_INJECTION_BLOCK_THRESHOLD;
  if (configured && ['low', 'medium', 'high', 'critical'].includes(configured)) {
    return configured;
  }
  return 'high';
}

const SEVERITY_ORDER = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };

function shouldBlock(risk, env = process.env) {
  const threshold = blockThreshold(env);
  return SEVERITY_ORDER[risk.severity] >= SEVERITY_ORDER[threshold];
}

function createPromptInjectionDetector({ env = process.env } = {}) {
  return {
    detect(text) {
      return scoreInjectionRisk(text);
    },

    middleware(opts = {}) {
      return (req, res, next) => {
        const body = req.body || {};
        const fieldsToCheck = opts.fields || ['prompt', 'content', 'messages'];

        let checkText = '';
        for (const field of fieldsToCheck) {
          const value = body[field];
          if (typeof value === 'string') {
            checkText += ` ${value}`;
          } else if (Array.isArray(value)) {
            for (const item of value) {
              if (item?.content && typeof item.content === 'string') {
                checkText += ` ${item.content}`;
              }
            }
          }
        }

        if (!checkText.trim()) return next();

        const risk = scoreInjectionRisk(checkText);
        req.promptInjectionRisk = risk;

        if (shouldBlock(risk, env)) {
          return res.status(400).json({
            error: 'prompt_injection_detected',
            severity: risk.severity,
            message: 'La solicitud contiene patrones sospechosos y ha sido bloqueada.',
          });
        }

        next();
      };
    },
  };
}

module.exports = {
  INJECTION_PATTERNS,
  SEVERITY_THRESHOLDS,
  blockThreshold,
  createPromptInjectionDetector,
  scoreInjectionRisk,
  shouldBlock,
};
