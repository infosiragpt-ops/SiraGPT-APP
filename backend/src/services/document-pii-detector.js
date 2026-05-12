'use strict';

/**
 * document-pii-detector.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Surfaces PII and sensitive-data signals in attached documents BEFORE they
 * reach the LLM, so the chat prompt can carry an explicit safety frame
 * ("the document contains 4 credit-card numbers, 2 IBANs, and a leaked API
 * key — handle with care, do not echo back verbatim").
 *
 * Detection coverage (all heuristic, language-aware where it matters):
 *   - Credit cards (Luhn-validated, brand-recognised)
 *   - IBAN (mod-97 checksum)
 *   - SWIFT/BIC codes
 *   - US SSN
 *   - Spanish DNI / NIE (letter-checksum)
 *   - Peruvian RUC (mod-11 checksum)
 *   - Mexican CURP / RFC patterns (structural)
 *   - Generic national-id-like 8-12 digit numbers near "DNI/ID/Cédula" labels
 *   - Emails (already in insights engine, but counted here for safety scoring)
 *   - Phone numbers (E.164 + national variants)
 *   - IPv4 / IPv6 addresses
 *   - MAC addresses
 *   - JWTs (3-segment base64)
 *   - API keys (provider-specific prefixes: sk_live_*, AKIA*, ghp_*, xoxb-*, etc.)
 *   - Private keys (PEM markers)
 *   - AWS access keys
 *   - URLs containing credentials in the userinfo
 *   - Geolocation pairs (lat,lon)
 *
 * Public API:
 *   detectPii(text, opts)                → PiiReport
 *   buildPiiReportForFiles(files)        → { perFile: PiiReport[], aggregate: PiiReport }
 *   renderPiiSafetyBlock(report)         → markdown string
 *
 * Constraints: pure function, sync, no LLM, no network, <40 ms / 1 MB.
 *
 * IMPORTANT: this engine never logs the matched values themselves at the
 * info/warn level — only counts, types, and one-character-masked previews.
 * The renderer redacts values before they appear in the prompt block; the
 * model is told what KIND of PII exists and how many instances, not the
 * raw content.
 */

const SCAN_HEAD_BYTES = 64_000;
const MAX_SAMPLES_PER_TYPE = 6;

function safeText(value) {
  return typeof value === 'string' ? value : '';
}

// ──────────────────────────────────────────────────────────────────────────
// Detector building blocks
// ──────────────────────────────────────────────────────────────────────────

function luhnCheck(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function ibanCheck(iban) {
  // Move first 4 chars to the end, replace letters with digits, mod 97 == 1
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const digits = rearranged
    .toUpperCase()
    .split('')
    .map((c) => {
      const code = c.charCodeAt(0);
      if (code >= 48 && code <= 57) return c; // 0-9
      if (code >= 65 && code <= 90) return String(code - 55); // A-Z
      return null;
    });
  if (digits.includes(null)) return false;
  const flat = digits.join('');
  // Use stepwise mod-97 to avoid bigint
  let remainder = 0;
  for (let i = 0; i < flat.length; i++) {
    remainder = (remainder * 10 + (flat.charCodeAt(i) - 48)) % 97;
  }
  return remainder === 1;
}

function dniSpanishCheck(dni) {
  // 8 digits + 1 letter; letter is computed from digits mod 23
  const m = /^(\d{8})([A-Z])$/.exec(dni.toUpperCase());
  if (!m) return false;
  const letters = 'TRWAGMYFPDXBNJZSQVHLCKE';
  const expected = letters[Number(m[1]) % 23];
  return expected === m[2];
}

function nieSpanishCheck(nie) {
  const m = /^([XYZ])(\d{7})([A-Z])$/.exec(nie.toUpperCase());
  if (!m) return false;
  const prefixMap = { X: '0', Y: '1', Z: '2' };
  const num = Number(prefixMap[m[1]] + m[2]);
  const letters = 'TRWAGMYFPDXBNJZSQVHLCKE';
  return letters[num % 23] === m[3];
}

function rucPeruCheck(ruc) {
  if (!/^\d{11}$/.test(ruc)) return false;
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(ruc[i]) * weights[i];
  const remainder = sum % 11;
  const checkDigit = (11 - remainder) % 10;
  return checkDigit === Number(ruc[10]);
}

function maskValue(value) {
  if (!value) return '';
  const v = String(value);
  if (v.length <= 4) return '*'.repeat(v.length);
  return `${v.slice(0, 2)}${'*'.repeat(Math.max(2, v.length - 4))}${v.slice(-2)}`;
}

// ──────────────────────────────────────────────────────────────────────────
// Detectors
// ──────────────────────────────────────────────────────────────────────────

function detectCreditCards(text) {
  // 13–19 digits, possibly grouped by spaces or dashes. Validate with Luhn.
  const candidates = text.match(/\b(?:\d[ -]?){13,19}\b/g) || [];
  const found = [];
  for (const raw of candidates) {
    const digits = raw.replace(/[\s-]/g, '');
    if (digits.length < 13 || digits.length > 19) continue;
    if (!luhnCheck(digits)) continue;
    let brand = 'unknown';
    if (/^4\d{12}(\d{3})?(\d{3})?$/.test(digits)) brand = 'visa';
    else if (/^5[1-5]\d{14}$/.test(digits) || /^2(2[2-9]\d|[3-6]\d{2}|7([01]\d|20))\d{12}$/.test(digits)) brand = 'mastercard';
    else if (/^3[47]\d{13}$/.test(digits)) brand = 'amex';
    else if (/^6(?:011|5\d{2})\d{12}$/.test(digits)) brand = 'discover';
    found.push({ kind: 'credit_card', brand, masked: maskValue(digits) });
    if (found.length >= MAX_SAMPLES_PER_TYPE) break;
  }
  return found;
}

function detectIban(text) {
  const candidates = text.match(/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g) || [];
  const found = [];
  for (const raw of candidates) {
    if (!ibanCheck(raw)) continue;
    found.push({ kind: 'iban', country: raw.slice(0, 2), masked: maskValue(raw) });
    if (found.length >= MAX_SAMPLES_PER_TYPE) break;
  }
  return found;
}

function detectSwift(text) {
  // SWIFT/BIC: 4 bank chars + 2 country + 2 location + optional 3 branch
  const candidates = text.match(/\b[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b/g) || [];
  const seen = new Set();
  const found = [];
  for (const raw of candidates) {
    if (raw.length < 8 || raw.length > 11) continue;
    if (seen.has(raw)) continue;
    // Heuristic: skip strings that look like generic IDs (very repetitive
    // characters or zero entropy on the bank prefix).
    if (/^([A-Z])\1{3}/.test(raw)) continue;
    seen.add(raw);
    found.push({ kind: 'swift_bic', masked: maskValue(raw) });
    if (found.length >= MAX_SAMPLES_PER_TYPE) break;
  }
  return found;
}

function detectUsSsn(text) {
  // ###-##-#### with no obvious leading 000/666/9##
  const re = /\b(\d{3})-(\d{2})-(\d{4})\b/g;
  let m;
  const found = [];
  while ((m = re.exec(text)) !== null) {
    const a = m[1];
    if (a === '000' || a === '666' || a.startsWith('9')) continue;
    if (m[2] === '00' || m[3] === '0000') continue;
    found.push({ kind: 'us_ssn', masked: `***-**-${m[3]}` });
    if (found.length >= MAX_SAMPLES_PER_TYPE) break;
  }
  return found;
}

function detectSpanishIds(text) {
  const found = [];
  const dniMatches = text.match(/\b\d{8}[A-HJ-NP-TV-Z]\b/g) || [];
  for (const m of dniMatches) {
    if (dniSpanishCheck(m)) {
      found.push({ kind: 'es_dni', masked: maskValue(m) });
      if (found.length >= MAX_SAMPLES_PER_TYPE) break;
    }
  }
  const nieMatches = text.match(/\b[XYZ]\d{7}[A-HJ-NP-TV-Z]\b/g) || [];
  for (const m of nieMatches) {
    if (nieSpanishCheck(m)) {
      found.push({ kind: 'es_nie', masked: maskValue(m) });
      if (found.length >= MAX_SAMPLES_PER_TYPE * 2) break;
    }
  }
  return found;
}

function detectPeruvianRuc(text) {
  const candidates = text.match(/\b\d{11}\b/g) || [];
  const found = [];
  for (const raw of candidates) {
    if (rucPeruCheck(raw)) {
      found.push({ kind: 'pe_ruc', masked: maskValue(raw) });
      if (found.length >= MAX_SAMPLES_PER_TYPE) break;
    }
  }
  return found;
}

function detectMexicanIds(text) {
  const found = [];
  // CURP — 18 chars: 4 letters + 6 digits + 6 letters + 2 alphanum
  const curpRe = /\b[A-Z]{4}\d{6}[HM][A-Z]{5}[0-9A-Z]\d\b/g;
  let m;
  while ((m = curpRe.exec(text)) !== null) {
    found.push({ kind: 'mx_curp', masked: maskValue(m[0]) });
    if (found.length >= MAX_SAMPLES_PER_TYPE) break;
  }
  // RFC — 12 (moral) or 13 (física) chars: 3-4 letters + 6 digits + 3 alphanum
  const rfcRe = /\b[A-ZÑ&]{3,4}\d{6}[A-Z\d]{3}\b/g;
  while ((m = rfcRe.exec(text)) !== null) {
    found.push({ kind: 'mx_rfc', masked: maskValue(m[0]) });
    if (found.length >= MAX_SAMPLES_PER_TYPE * 2) break;
  }
  return found;
}

function detectIpAddresses(text) {
  const found = [];
  const seen = new Set();
  // IPv4
  const v4Re = /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g;
  let m;
  while ((m = v4Re.exec(text)) !== null) {
    if (m[0] === '0.0.0.0' || m[0] === '127.0.0.1' || m[0] === '255.255.255.255') continue;
    if (seen.has(m[0])) continue;
    seen.add(m[0]);
    found.push({ kind: 'ipv4', masked: maskValue(m[0]) });
    if (found.length >= MAX_SAMPLES_PER_TYPE) break;
  }
  // IPv6 — relaxed match (any 4-hex-group sequence with ≥3 colons)
  const v6Re = /\b(?:[a-fA-F0-9]{1,4}:){3,7}[a-fA-F0-9]{1,4}\b/g;
  while ((m = v6Re.exec(text)) !== null) {
    if (seen.has(m[0])) continue;
    seen.add(m[0]);
    found.push({ kind: 'ipv6', masked: maskValue(m[0]) });
    if (found.length >= MAX_SAMPLES_PER_TYPE * 2) break;
  }
  return found;
}

function detectMacAddresses(text) {
  const found = [];
  const re = /\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    found.push({ kind: 'mac_address', masked: maskValue(m[0]) });
    if (found.length >= MAX_SAMPLES_PER_TYPE) break;
  }
  return found;
}

function detectJwt(text) {
  // 3 base64url segments separated by dots; first must be a JWT header
  const re = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
  const found = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    found.push({ kind: 'jwt', masked: maskValue(m[0]) });
    if (found.length >= MAX_SAMPLES_PER_TYPE) break;
  }
  return found;
}

function detectApiKeys(text) {
  const patterns = [
    { kind: 'aws_access_key', re: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g },
    { kind: 'aws_secret_key', re: /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/g, requireContext: /\b(?:aws_secret_access_key|secretkey|secret_key)\b/i },
    { kind: 'github_token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g },
    { kind: 'github_fine_grained', re: /\bgithub_pat_[A-Za-z0-9_]{82,}\b/g },
    { kind: 'slack_token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
    { kind: 'stripe_secret', re: /\bsk_(live|test)_[A-Za-z0-9]{24,}\b/g },
    { kind: 'openai_key', re: /\bsk-[A-Za-z0-9]{20,}\b/g },
    { kind: 'anthropic_key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
    { kind: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
    { kind: 'twilio_sid', re: /\bAC[a-f0-9]{32}\b/g },
    { kind: 'sendgrid_key', re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g },
    { kind: 'jwt_bearer_header', re: /\bBearer\s+eyJ[A-Za-z0-9_-]{10,}/g },
  ];
  const found = [];
  for (const p of patterns) {
    if (p.requireContext && !p.requireContext.test(text)) continue;
    const matches = text.match(p.re) || [];
    for (const raw of matches) {
      found.push({ kind: p.kind, masked: maskValue(raw) });
      if (found.length >= MAX_SAMPLES_PER_TYPE * 4) return found;
    }
  }
  return found;
}

function detectPemPrivateKey(text) {
  const found = [];
  if (/-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |)PRIVATE KEY-----/.test(text)) {
    found.push({ kind: 'private_key_pem', masked: '-----BEGIN ... PRIVATE KEY-----' });
  }
  return found;
}

function detectCredentialedUrls(text) {
  const re = /\b(?:https?|ftp|ssh|postgres|mysql|mongodb|redis):\/\/[^/\s:@]+:[^/\s@]+@[^\s]+/g;
  const matches = text.match(re) || [];
  return matches.slice(0, MAX_SAMPLES_PER_TYPE).map((u) => {
    // Mask user:pass@host part
    const masked = u.replace(/:\/\/([^/\s:@]+):([^/\s@]+)@/, '://***:***@');
    return { kind: 'credentialed_url', masked };
  });
}

function detectPhones(text) {
  // Heuristic phone detector — relies on common formats. Insights engine has
  // its own; this one focuses on counting for the safety severity score.
  const re = /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d{2,4}[\s.-]?\d{2,4}[\s.-]?\d{2,4}/g;
  const matches = text.match(re) || [];
  const filtered = matches.filter((m) => {
    const digits = m.replace(/\D/g, '');
    return digits.length >= 8 && digits.length <= 15;
  });
  return Array.from(new Set(filtered)).slice(0, MAX_SAMPLES_PER_TYPE).map((p) => ({ kind: 'phone', masked: maskValue(p) }));
}

function detectEmails(text) {
  const re = /\b[\w.+-]+@[\w-]+\.[A-Za-z]{2,}\b/g;
  const matches = text.match(re) || [];
  return Array.from(new Set(matches)).slice(0, MAX_SAMPLES_PER_TYPE).map((e) => {
    const at = e.indexOf('@');
    return { kind: 'email', masked: `${e.slice(0, 1)}***${e.slice(at - 1)}` };
  });
}

function detectGeoCoordinates(text) {
  // Pairs like "(lat, lon)" or "lat=..., lon=..." with sane ranges
  const re = /(-?(?:90|[1-8]?\d)(?:\.\d+)?)\s*,\s*(-?(?:180|1[0-7]\d|[1-9]?\d)(?:\.\d+)?)/g;
  const found = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    found.push({ kind: 'geo_coordinates', masked: `${m[1]}, ${m[2]}` });
    if (found.length >= MAX_SAMPLES_PER_TYPE) break;
  }
  return found;
}

function detectGenericNationalId(text) {
  // 8-12 digit numbers preceded by labels like DNI, ID, Cédula, Pasaporte
  const re = /\b(DNI|NIF|NIE|ID|cedula|cédula|RG|CPF|passport|pasaporte|carnet)\b\s*[:#]?\s*([A-Z0-9-]{6,15})/gi;
  const found = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    found.push({ kind: `national_id:${m[1].toLowerCase()}`, masked: maskValue(m[2]) });
    if (found.length >= MAX_SAMPLES_PER_TYPE) break;
  }
  return found;
}

// ──────────────────────────────────────────────────────────────────────────
// Aggregation
// ──────────────────────────────────────────────────────────────────────────

function summariseFindings(findings) {
  const counts = new Map();
  for (const f of findings) {
    counts.set(f.kind, (counts.get(f.kind) || 0) + 1);
  }
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).map(([kind, count]) => ({ kind, count }));
}

const SEVERITY_WEIGHTS = {
  credit_card: 8,
  iban: 6,
  swift_bic: 3,
  us_ssn: 7,
  es_dni: 5,
  es_nie: 5,
  pe_ruc: 3,
  mx_curp: 4,
  mx_rfc: 3,
  ipv4: 1,
  ipv6: 1,
  mac_address: 1,
  jwt: 6,
  jwt_bearer_header: 6,
  aws_access_key: 9,
  aws_secret_key: 10,
  github_token: 9,
  github_fine_grained: 9,
  slack_token: 7,
  stripe_secret: 10,
  openai_key: 9,
  anthropic_key: 9,
  google_api_key: 7,
  twilio_sid: 5,
  sendgrid_key: 8,
  private_key_pem: 10,
  credentialed_url: 7,
  email: 1,
  phone: 1,
  geo_coordinates: 2,
};

function computeSeverity(summary) {
  let score = 0;
  for (const item of summary) {
    const baseKind = item.kind.startsWith('national_id:') ? 'es_dni' : item.kind;
    score += (SEVERITY_WEIGHTS[baseKind] || 1) * item.count;
  }
  let level = 'none';
  if (score >= 30) level = 'critical';
  else if (score >= 15) level = 'high';
  else if (score >= 6) level = 'medium';
  else if (score > 0) level = 'low';
  return { score, level };
}

function detectPii(text) {
  const safe = safeText(text);
  if (!safe.trim()) {
    return { totalFindings: 0, summary: [], severity: { score: 0, level: 'none' }, samples: [] };
  }
  const head = safe.slice(0, SCAN_HEAD_BYTES);

  const findings = [
    ...detectCreditCards(head),
    ...detectIban(head),
    ...detectSwift(head),
    ...detectUsSsn(head),
    ...detectSpanishIds(head),
    ...detectPeruvianRuc(head),
    ...detectMexicanIds(head),
    ...detectIpAddresses(head),
    ...detectMacAddresses(head),
    ...detectJwt(head),
    ...detectApiKeys(safe), // scan full text — keys can hide deep in logs
    ...detectPemPrivateKey(safe),
    ...detectCredentialedUrls(head),
    ...detectGeoCoordinates(head),
    ...detectGenericNationalId(head),
    ...detectEmails(head),
    ...detectPhones(head),
  ];

  const summary = summariseFindings(findings);
  const severity = computeSeverity(summary);
  // Keep at most 16 sample rows for the rendered block — never expose more.
  const samples = findings.slice(0, 16);
  return { totalFindings: findings.length, summary, severity, samples };
}

function buildPiiReportForFiles(files) {
  const list = Array.isArray(files) ? files : [];
  const perFile = [];
  let combinedText = '';
  for (const f of list) {
    if (!f || typeof f !== 'object') continue;
    const text = safeText(f.extractedText || f.text || '');
    if (!text.trim()) continue;
    const label = f.originalName || f.filename || f.name || 'archivo';
    perFile.push({ file: label, report: detectPii(text) });
    if (combinedText.length < 100_000) combinedText += `\n${text.slice(0, 16_000)}`;
  }
  return {
    perFile,
    aggregate: detectPii(combinedText),
  };
}

const SEVERITY_BADGE = {
  none: '🟢',
  low: '🟢',
  medium: '🟡',
  high: '🟠',
  critical: '🔴',
};

function renderPiiSafetyBlock(report, opts = {}) {
  if (!report) return '';
  // Two shapes accepted: single PiiReport, or { perFile, aggregate }
  const aggregate = report.aggregate || report;
  if (!aggregate || aggregate.totalFindings === 0) return '';

  const lines = [];
  const title = opts.title || 'PII & SECURITY FLAGS';
  lines.push(`## ${title} ${SEVERITY_BADGE[aggregate.severity.level] || ''} ${aggregate.severity.level.toUpperCase()}`);
  lines.push('The attached document(s) contain sensitive identifiers detected before LLM ingest. Apply this safety frame:');
  lines.push('- **Do NOT echo raw PII verbatim** in your response. Refer to it generically ("the credit card number on p. 4", "the API key on line 12").');
  lines.push('- **Recommend redaction** before the user shares this document elsewhere.');
  lines.push('- **Flag credential leaks** (API keys, tokens, private keys) as immediate rotation priority — list the leaked credentials, do not reproduce them.');
  lines.push('- **Decline** to generate variations, expansions, or examples that include the raw PII.');

  if (aggregate.summary.length > 0) {
    lines.push('### Findings');
    for (const item of aggregate.summary) {
      lines.push(`- ${item.kind}: ${item.count} instance${item.count === 1 ? '' : 's'}`);
    }
  }

  if (report.perFile && report.perFile.length > 0) {
    const filesWithFindings = report.perFile.filter((p) => p.report.totalFindings > 0);
    if (filesWithFindings.length > 0) {
      lines.push('### Per-file');
      for (const p of filesWithFindings) {
        const kinds = p.report.summary.map((s) => `${s.count} × ${s.kind}`).join(', ');
        lines.push(`- **${p.file}** (${SEVERITY_BADGE[p.report.severity.level]} ${p.report.severity.level}) — ${kinds}`);
      }
    }
  }

  return lines.join('\n\n');
}

module.exports = {
  detectPii,
  buildPiiReportForFiles,
  renderPiiSafetyBlock,
  _internal: {
    luhnCheck,
    ibanCheck,
    dniSpanishCheck,
    nieSpanishCheck,
    rucPeruCheck,
    maskValue,
    SEVERITY_WEIGHTS,
  },
};
