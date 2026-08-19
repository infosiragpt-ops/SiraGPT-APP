/**
 * pii-scrubber — redact PII from text before it leaves the system.
 *
 * Ouyang et al. 2022 explicitly remove PII from the training prompt
 * distribution before fine-tuning. Our preference-export currently
 * emits user requests verbatim — if a user thumbed-up a chat where
 * they pasted their own email, that email lands in the JSONL the
 * caller is about to upload to OpenAI for fine-tuning. That is
 * both a privacy violation and — for anyone subject to GDPR or
 * equivalent — a legal one.
 *
 * This module provides regex-based redaction for the common
 * identifiers that leak in real chat logs: emails, phone numbers,
 * SSNs, credit cards, IP addresses, and secret-shaped tokens. It
 * does NOT attempt general NER-based name redaction — doing that
 * well requires a model and introduces new failure modes (redacting
 * "Alice" from a programming tutorial). For name-level redaction the
 * user should add a dedicated step downstream.
 *
 * API:
 *   scrub(text, { aggressive? }) → { scrubbed, hits[] }
 *   scrubRecord(obj, { aggressive? }) → deep-cloned obj with redactions
 *
 * Each replacement tokens is a stable placeholder — `<EMAIL>`,
 * `<PHONE>`, etc. — so the training data retains structural clues
 * (the fact that an email was present) without the actual value.
 */

const PATTERNS = [
  {
    id: 'email',
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    token: '<EMAIL>',
  },
  {
    id: 'ssn',
    re: /\b\d{3}-\d{2}-\d{4}\b/g,
    token: '<SSN>',
  },
  {
    id: 'credit_card',
    // 16-digit groups (4-4-4-4 or contiguous) — must run BEFORE the
    // generic phone pattern below because a contiguous 16-digit string
    // would also partially match phone regex.
    re: /\b(?:\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}|\d{15,19})\b/g,
    token: '<CREDIT_CARD>',
  },
  {
    id: 'phone',
    // International or US-shaped phone numbers. Strict enough to avoid
    // matching plain "123-45" or short codes.
    re: /\b(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g,
    token: '<PHONE>',
  },
  {
    id: 'ipv4',
    re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    token: '<IP>',
  },
  {
    id: 'aws_key',
    re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    token: '<AWS_KEY>',
  },
  {
    id: 'openai_key',
    re: /\bsk-[A-Za-z0-9]{20,}\b/g,
    token: '<OPENAI_KEY>',
  },
  {
    id: 'github_token',
    re: /\bghp_[A-Za-z0-9]{36}\b/g,
    token: '<GITHUB_TOKEN>',
  },
  {
    id: 'slack_token',
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    token: '<SLACK_TOKEN>',
  },
  {
    id: 'jwt',
    re: /\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g,
    token: '<JWT>',
  },
  {
    id: 'private_key_pem',
    // PEM-armored private keys (RSA / EC / OpenSSH).
    re: /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/g,
    token: '<PRIVATE_KEY>',
  },
];

// Optional extra patterns enabled by { aggressive: true }. These have
// higher false-positive risk, so they're opt-in.
const AGGRESSIVE_PATTERNS = [
  {
    id: 'url_with_credentials',
    // URLs with embedded userinfo (user:pass@host)
    re: /\bhttps?:\/\/[^/\s:]+:[^@\s]+@[^\s]+/gi,
    token: '<URL_WITH_CREDS>',
  },
  {
    id: 'hex_id_long',
    // Runs of 32+ hex chars — often MD5/SHA hashes of IDs or raw secrets.
    re: /\b[a-f0-9]{32,}\b/gi,
    token: '<HEX_ID>',
  },
  {
    id: 'uuid',
    re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    token: '<UUID>',
  },
];

/**
 * Scrub a single string. Returns { scrubbed, hits } where hits is an
 * array of { id, count } describing what was redacted.
 */
function scrub(text, { aggressive = false } = {}) {
  if (typeof text !== 'string' || text.length === 0) return { scrubbed: text, hits: [] };
  let out = text;
  const hits = [];
  const rules = aggressive ? PATTERNS.concat(AGGRESSIVE_PATTERNS) : PATTERNS;
  for (const { id, re, token } of rules) {
    re.lastIndex = 0;
    let count = 0;
    out = out.replace(re, () => { count++; return token; });
    if (count > 0) hits.push({ id, count });
  }
  return { scrubbed: out, hits };
}

/**
 * Deep-scrub an object: walk its structure, scrub every string value.
 * Returns a NEW object; the input is never mutated. Hit counts are
 * aggregated across all scrubbed strings.
 */
function scrubRecord(obj, opts = {}) {
  const hits = [];
  const agg = (result) => {
    for (const h of result.hits) {
      const existing = hits.find(e => e.id === h.id);
      if (existing) existing.count += h.count;
      else hits.push({ ...h });
    }
  };

  const walk = (v) => {
    if (v === null || v === undefined) return v;
    if (typeof v === 'string') {
      const r = scrub(v, opts);
      agg(r);
      return r.scrubbed;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  };

  return { scrubbed: walk(obj), hits };
}

module.exports = {
  scrub,
  scrubRecord,
  PATTERNS,
  AGGRESSIVE_PATTERNS,
};
