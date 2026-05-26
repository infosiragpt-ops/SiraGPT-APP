/**
 * safety-filter — output-side safety / toxicity check.
 *
 * Complements injection-guard which is INPUT-side (did the user try to
 * inject instructions?). safety-filter is OUTPUT-side (did the model
 * produce content that would be harmful, leak PII, or embed unsafe
 * code?). Both are necessary — an aligned pipeline needs defense at
 * both boundaries.
 *
 * Two layers:
 *   1. DETERMINISTIC patterns — fast, high precision, no LLM cost.
 *      Catches: PII leaks, known unsafe shell commands, SQL-injection
 *      payloads, API-key patterns in generated code, plaintext passwords.
 *   2. LLM MODERATOR (optional, llmModerator:true) — flags borderline
 *      toxicity / bias / harmful suggestions that regex can't catch.
 *
 * Like truthfulness, this is ADVISORY. We flag; the caller decides
 * whether to redact, warn, or pass through. Blocking aligned output
 * on a regex hit creates more user frustration than it prevents harm
 * — that's what the alignment pipeline's judge is for, with its
 * harmless axis.
 */

const DEFAULT_MODEL = 'gpt-4o-mini';

// ─── Deterministic patterns ───────────────────────────────────────────────

const PATTERNS = [
  // PII — these are patterns the response shouldn't contain even if the
  // user included them in their input, because echoing PII back is bad UX
  // and creates a leak path.
  {
    id: 'email_in_response',
    severity: 'info',
    description: 'Response contains an email address',
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
    message: 'email address echoed in response',
  },
  {
    id: 'phone_number',
    severity: 'info',
    description: 'Response contains a phone-number-shaped string',
    re: /\b(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/,
    message: 'phone number in response',
  },
  {
    id: 'ssn',
    severity: 'high',
    description: 'US SSN pattern',
    re: /\b\d{3}-\d{2}-\d{4}\b/,
    message: 'SSN-shaped number in response',
  },
  {
    id: 'credit_card',
    severity: 'high',
    description: 'Credit-card-shaped number',
    // 16 digits grouped 4-4-4-4 or runs of 13-19 digits.
    re: /\b(?:\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}|\d{13,19})\b/,
    message: 'credit-card-shaped number',
  },
  // Secrets — see also injection-guard which scans INPUT for the same.
  // Here we scan OUTPUT: the model should not generate these even as
  // examples.
  {
    id: 'aws_key',
    severity: 'critical',
    description: 'AWS access key in response',
    re: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/,
    message: 'AWS access key ID generated',
  },
  {
    id: 'openai_key',
    severity: 'critical',
    description: 'OpenAI API key in response',
    re: /\bsk-[A-Za-z0-9]{20,}\b/,
    message: 'OpenAI-style secret key generated',
  },
  {
    id: 'github_token',
    severity: 'critical',
    description: 'GitHub PAT in response',
    re: /\bghp_[A-Za-z0-9]{36}\b/,
    message: 'GitHub personal access token generated',
  },
  {
    id: 'slack_token',
    severity: 'critical',
    description: 'Slack token in response',
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    message: 'Slack token generated',
  },
  {
    id: 'jwt',
    severity: 'high',
    description: 'JWT-shaped token in response',
    re: /\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/,
    message: 'JWT-shaped token generated',
  },
  // Unsafe code suggestions
  {
    id: 'rm_rf_root',
    severity: 'critical',
    description: 'Destructive rm -rf near filesystem root',
    re: /rm\s+-[rR]f?\s+(?:\/|\/\*|~\/?\*?|\$HOME\/?\*?)/,
    message: 'rm -rf of a root/home path suggested',
  },
  {
    id: 'drop_database',
    severity: 'high',
    description: 'DROP DATABASE / TABLE without clear scope',
    re: /\bDROP\s+(DATABASE|TABLE)\b/i,
    message: 'destructive DROP statement in response',
  },
  {
    id: 'curl_sh_pipe',
    severity: 'high',
    description: 'curl | sh — unsafe remote-execution pattern',
    re: /\bcurl\s+[^\n|]*\|\s*(?:ba)?sh\b/,
    message: 'curl-piped-to-shell suggested',
  },
  // Prompt leak
  {
    id: 'system_prompt_leak',
    severity: 'warn',
    description: 'Response echoes the system prompt structure',
    re: /^(?:system|assistant)\s*[:>]\s*you\s+are/i,
    message: 'output appears to expose a system prompt',
  },
];

function scanDeterministic(text) {
  if (!text || typeof text !== 'string') return [];
  const out = [];
  for (const p of PATTERNS) {
    const m = text.match(p.re);
    if (m) out.push({
      rule: p.id,
      severity: p.severity,
      message: p.message,
      sample: String(m[0]).slice(0, 80),
    });
  }
  return out;
}

// ─── LLM moderator (optional) ─────────────────────────────────────────────

const MODERATOR_SYSTEM = `You flag safety issues in an AI system's OUTPUT (not input).

For the response below, list any:
- toxic / hateful / biased / discriminatory content
- instructions for clearly unsafe activities (weapons, malware, self-harm)
- harmful code patterns that a deterministic lint wouldn't catch

Reply with STRICT JSON:
{"flags": [{"category": "<short>", "severity": "info|warn|high|critical", "message": "<one sentence>"}]}

Return {"flags": []} when the response is clean. Err on the side of NOT flagging normal code reviews, explanations, or factual answers — this is not a content filter, it's a safety backstop.`;

async function llmModerate({ openai, response, model = DEFAULT_MODEL }) {
  if (!openai || !response) return [];
  try {
    const resp = await openai.chat.completions.create({
      model, temperature: 0.0, max_tokens: 300,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: MODERATOR_SYSTEM },
        { role: 'user',   content: String(response).slice(0, 8000) },
      ],
    });
    const raw = resp.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.flags)) return [];
    return parsed.flags
      .map(f => ({
        rule: `llm_moderator:${String(f?.category || 'unspecified').slice(0, 40)}`,
        severity: ['info', 'warn', 'high', 'critical'].includes(f?.severity) ? f.severity : 'warn',
        message: String(f?.message || '').slice(0, 200),
        sample: '',
      }))
      .filter(f => f.message)
      .slice(0, 5);
  } catch (err) {
    console.warn('[safety-filter] LLM moderator failed:', err.message);
    return [];
  }
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Check a response for safety issues.
 *
 * @param {object} args
 * @param {object} [args.openai]       — enables LLM moderator path
 * @param {string|object} args.response
 * @param {boolean} [args.llmModerator=false] — run the LLM moderator too
 * @param {string} [args.model]
 *
 * @returns {Promise<{
 *   flagged: boolean,
 *   findings: [{rule, severity, message, sample}],
 *   counts: { critical, high, warn, info },
 *   summary: string,
 * }>}
 */
async function check({ openai, response, llmModerator = false, model = DEFAULT_MODEL }) {
  const text = typeof response === 'string' ? response : JSON.stringify(response || '');

  const findings = scanDeterministic(text);
  if (llmModerator && openai && text.trim().length > 0) {
    const llmFlags = await llmModerate({ openai, response: text, model });
    findings.push(...llmFlags);
  }

  // Stable sort by severity for downstream consumption.
  const order = { critical: 0, high: 1, warn: 2, info: 3 };
  findings.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));

  const counts = { critical: 0, high: 0, warn: 0, info: 0 };
  for (const f of findings) {
    if (counts[f.severity] !== undefined) counts[f.severity]++;
  }

  return {
    flagged: findings.length > 0,
    findings,
    counts,
    summary: findings.length === 0
      ? 'no safety issues detected'
      : `${findings.length} safety issue${findings.length > 1 ? 's' : ''} detected`,
  };
}

module.exports = {
  check,
  scanDeterministic,
  llmModerate,
  PATTERNS,
  MODERATOR_SYSTEM,
};
