/**
 * secret-scanner — regex-based detector that flags probable secrets
 * (AWS keys, GitHub tokens, Slack, Stripe, private keys, JWTs,
 * generic high-entropy API-key shapes) in any text / buffer the
 * agent is about to persist, commit, or ship to the user.
 *
 * The scanner is intentionally DETERMINISTIC and offline — no
 * calls to remote scanners, no ML classifier. It emits structured
 * Findings compatible with the ValidationFabric's SecurityReport
 * shape, so the aggregator can decide release/hold/reject without
 * further translation.
 *
 * Patterns are taken from public specs (AWS doc, GitHub docs,
 * Stripe docs, RFC 7519 JWT, PEM RFC 7468). When in doubt we
 * flag with `suspected` severity rather than `confirmed` — the
 * aggregator handles policy.
 */

const PATTERNS = [
  {
    id: "aws_access_key",
    severity: "critical",
    description: "AWS Access Key ID (20 chars, AKIA/ASIA prefix).",
    regex: /\b(A(?:KIA|SIA|GPA|ROA|IDA|NPA|NVA|IPA|RPA|SCA))[A-Z0-9]{16}\b/g,
  },
  {
    id: "aws_secret_key",
    severity: "critical",
    description: "AWS Secret Access Key (40 base64 chars near the key).",
    // 40-char base64 with aws-secret key-line context nearby
    regex: /(?:aws[_-]?secret[_-]?(?:access)?[_-]?key)\s*[:=]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/gi,
  },
  {
    id: "github_pat",
    severity: "critical",
    description: "GitHub Personal Access Token (fine-grained or classic).",
    regex: /\bghp_[A-Za-z0-9]{36,251}\b|\bgithub_pat_[A-Za-z0-9_]{80,}\b/g,
  },
  {
    id: "github_oauth",
    severity: "high",
    description: "GitHub OAuth client token (gho_).",
    regex: /\bgho_[A-Za-z0-9]{36,251}\b/g,
  },
  {
    id: "github_app",
    severity: "high",
    description: "GitHub App token (ghu_ / ghs_ / ghr_).",
    regex: /\bgh[usr]_[A-Za-z0-9]{36,251}\b/g,
  },
  {
    id: "slack_token",
    severity: "high",
    description: "Slack workspace / bot / user token.",
    regex: /\bxox[abpso]-[0-9A-Za-z-]{10,72}\b/g,
  },
  {
    id: "stripe_live",
    severity: "critical",
    description: "Stripe live secret or restricted key.",
    regex: /\b(sk|rk)_live_[A-Za-z0-9]{24,60}\b/g,
  },
  {
    id: "stripe_test",
    severity: "medium",
    description: "Stripe test secret key (low-risk but still a secret).",
    regex: /\bsk_test_[A-Za-z0-9]{24,60}\b/g,
  },
  {
    id: "google_api_key",
    severity: "high",
    description: "Google API key (AIza prefix).",
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    id: "openai_key",
    severity: "critical",
    description: "OpenAI API key (sk- prefix, 48+ chars).",
    regex: /\bsk-[A-Za-z0-9]{48,}\b/g,
  },
  {
    id: "anthropic_key",
    severity: "critical",
    description: "Anthropic API key (sk-ant-... prefix).",
    regex: /\bsk-ant-[A-Za-z0-9_\-]{95,}\b/g,
  },
  {
    id: "private_key_pem",
    severity: "critical",
    description: "PEM-encoded private key block.",
    regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g,
  },
  {
    id: "jwt",
    severity: "medium",
    description: "JWT (3-segment base64url).",
    // header.payload.signature; at least 10+ chars each segment
    regex: /\b(eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,})\b/g,
  },
  {
    id: "generic_api_key",
    severity: "low",
    description: "Generic high-entropy 32+ char token adjacent to an api-key / secret / token key.",
    regex: /(?:api[_-]?key|secret|password|token)\s*[:=]\s*['"]([A-Za-z0-9_\-+/=]{32,})['"]/gi,
  },
];

/**
 * Redact the matched span in a fixed way so the caller can log
 * the finding without leaking the secret itself.
 */
function redact(match) {
  if (typeof match !== "string" || match.length < 6) return "***";
  return `${match.slice(0, 4)}…${match.slice(-2)} (len=${match.length})`;
}

/**
 * @param {string|Buffer} text
 * @param {object} [opts]
 * @param {string[]} [opts.ignorePatterns] — pattern ids to skip
 * @param {number}   [opts.maxFindings=100]
 * @returns {{ ok:boolean, findings:Array<{severity,code,detail,match,line}> }}
 */
function scanBuffer(text, opts = {}) {
  const raw = Buffer.isBuffer(text) ? text.toString("utf8") : String(text || "");
  if (!raw) return { ok: true, findings: [] };

  const ignore = new Set(Array.isArray(opts.ignorePatterns) ? opts.ignorePatterns : []);
  const maxFindings = typeof opts.maxFindings === "number" ? opts.maxFindings : 100;
  const lines = raw.split(/\r?\n/);
  const findings = [];

  for (const { id, severity, description, regex } of PATTERNS) {
    if (ignore.has(id)) continue;
    // Reset stateful regex between runs
    const pattern = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : regex.flags + "g");
    for (let i = 0; i < lines.length && findings.length < maxFindings; i++) {
      pattern.lastIndex = 0;
      let m;
      while ((m = pattern.exec(lines[i])) !== null && findings.length < maxFindings) {
        findings.push({
          severity,
          code: id,
          detail: description,
          match: redact(m[1] || m[0]),
          line: i + 1,
        });
        // Avoid infinite loops on zero-width matches
        if (m.index === pattern.lastIndex) pattern.lastIndex++;
      }
    }
  }

  return { ok: findings.length === 0, findings };
}

/**
 * Convenience: scan every string property of a JSON-ish blob and
 * return findings with an instance path. Useful for scanning
 * configuration, JSON artifacts, or serialized contracts.
 */
function scanJson(blob, opts = {}) {
  const collected = [];
  const walk = (node, path) => {
    if (node == null) return;
    if (typeof node === "string") {
      const r = scanBuffer(node, opts);
      for (const f of r.findings) collected.push({ ...f, path });
    } else if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`));
    } else if (typeof node === "object") {
      for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
    }
  };
  walk(blob, "");
  return { ok: collected.length === 0, findings: collected };
}

module.exports = {
  scanBuffer,
  scanJson,
  PATTERNS,
  redact,
};
