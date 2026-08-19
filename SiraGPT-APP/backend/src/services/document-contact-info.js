'use strict';

/**
 * document-contact-info.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pulls contact information out of attached documents — emails,
 * phone numbers, postal addresses, social handles. Routes "who can I
 * contact?" / "what's the support email?" to a citeable list.
 *
 * IMPORTANT — privacy: the rendered output keeps the values
 * verbatim, but emits a masked variant alongside (j***@example.com,
 * +1-***-***-1234) so the chat can choose to echo the masked form
 * when the user's question does not specifically require the raw
 * value. Document-pii-detector remains the source of truth for
 * deciding whether to redact PII inside body text.
 *
 * Deterministic. < 12 ms on 1 MB.
 *
 * Public API:
 *   extractContactInfo(text)             → ContactReport
 *   buildContactsForFiles(files)         → { perFile, aggregate }
 *   renderContactsBlock(report)          → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_PER_FILE_PER_KIND = 6;
const MAX_BLOCK_CHARS = 3800;

const EMAIL_RE = /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g;
const PHONE_RE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]?\d{3,4}[\s.-]?\d{2,4}/g;
const SOCIAL_RE = /\b(?:@[A-Za-z0-9_]{2,30}\b|(?:linkedin\.com\/in\/|twitter\.com\/|x\.com\/|github\.com\/|instagram\.com\/)[A-Za-z0-9_.\-]+)/g;
const ADDRESS_RE = /\b\d{1,5}\s+[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,4}\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Ln|Lane|Calle|Av|Avenida)\b/g;

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function maskEmail(email) {
  if (typeof email !== 'string') return '';
  const at = email.indexOf('@');
  if (at <= 1) return email;
  const local = email.slice(0, at);
  const domain = email.slice(at);
  return `${local[0]}${'*'.repeat(Math.max(1, local.length - 1))}${domain}`;
}

function maskPhone(phone) {
  if (typeof phone !== 'string') return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return phone;
  return phone.replace(/\d/g, (d, i, full) => {
    // Keep the last 4 digits visible.
    const lastDigit = (() => {
      const indexes = [];
      for (let k = 0; k < full.length; k++) if (/\d/.test(full[k])) indexes.push(k);
      return indexes[indexes.length - 4] ?? -1;
    })();
    return i >= lastDigit ? d : '*';
  });
}

function unique(arr) {
  const seen = new Set();
  const out = [];
  for (const v of arr) {
    const k = String(v).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

function extractContactInfo(input) {
  const text = safeText(input);
  if (!text) return { emails: [], phones: [], socials: [], addresses: [], total: 0 };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const emails = unique(Array.from(head.matchAll(EMAIL_RE), (m) => m[0])).slice(0, MAX_PER_FILE_PER_KIND);
  const phones = unique(Array.from(head.matchAll(PHONE_RE), (m) => m[0].trim())
    .filter((p) => p.replace(/\D/g, '').length >= 7))
    .slice(0, MAX_PER_FILE_PER_KIND);
  const socials = unique(Array.from(head.matchAll(SOCIAL_RE), (m) => m[0])).slice(0, MAX_PER_FILE_PER_KIND);
  const addresses = unique(Array.from(head.matchAll(ADDRESS_RE), (m) => m[0])).slice(0, MAX_PER_FILE_PER_KIND);
  return {
    emails: emails.map((e) => ({ raw: e, masked: maskEmail(e) })),
    phones: phones.map((p) => ({ raw: p, masked: maskPhone(p) })),
    socials,
    addresses,
    total: emails.length + phones.length + socials.length + addresses.length,
  };
}

function buildContactsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = { emails: [], phones: [], socials: [], addresses: [] };
  for (const f of list) {
    const r = extractContactInfo(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, report: r });
    aggregate.emails = aggregate.emails.concat(r.emails.map((e) => ({ ...e, file: name })));
    aggregate.phones = aggregate.phones.concat(r.phones.map((p) => ({ ...p, file: name })));
    aggregate.socials = aggregate.socials.concat(r.socials.map((s) => ({ value: s, file: name })));
    aggregate.addresses = aggregate.addresses.concat(r.addresses.map((a) => ({ value: a, file: name })));
  }
  return { perFile, aggregate };
}

function renderEmail(e, opts = {}) {
  const file = opts.includeFile && e.file ? ` _(${e.file})_` : '';
  return `- [EMAIL]${file} ${e.raw}  _(masked: ${e.masked})_`;
}
function renderPhone(p, opts = {}) {
  const file = opts.includeFile && p.file ? ` _(${p.file})_` : '';
  return `- [PHONE]${file} ${p.raw}  _(masked: ${p.masked})_`;
}
function renderSocial(s, opts = {}) {
  const file = opts.includeFile && s.file ? ` _(${s.file})_` : '';
  return `- [SOCIAL]${file} ${s.value || s}`;
}
function renderAddress(a, opts = {}) {
  const file = opts.includeFile && a.file ? ` _(${a.file})_` : '';
  return `- [ADDRESS]${file} ${a.value || a}`;
}

function renderContactsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const heading = `## CONTACT INFORMATION
Contact details surfaced from the attached document(s) — emails, phone numbers, social handles, postal addresses. Both the verbatim value and a masked variant are shown so the chat can choose which to echo based on the user's intent and any handling-policy labels (see DATA CLASSIFICATION).`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.report.emails) sections.push(renderEmail(e));
    for (const p of only.report.phones) sections.push(renderPhone(p));
    for (const s of only.report.socials) sections.push(renderSocial(s));
    for (const a of only.report.addresses) sections.push(renderAddress(a));
  } else {
    if (report.aggregate.emails.length) {
      sections.push('### Aggregate emails');
      for (const e of report.aggregate.emails) sections.push(renderEmail(e, { includeFile: true }));
    }
    if (report.aggregate.phones.length) {
      sections.push('### Aggregate phones');
      for (const p of report.aggregate.phones) sections.push(renderPhone(p, { includeFile: true }));
    }
    if (report.aggregate.socials.length) {
      sections.push('### Aggregate socials');
      for (const s of report.aggregate.socials) sections.push(renderSocial(s, { includeFile: true }));
    }
    if (report.aggregate.addresses.length) {
      sections.push('### Aggregate addresses');
      for (const a of report.aggregate.addresses) sections.push(renderAddress(a, { includeFile: true }));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...contacts block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractContactInfo,
  buildContactsForFiles,
  renderContactsBlock,
  _internal: {
    maskEmail,
    maskPhone,
    EMAIL_RE,
    PHONE_RE,
    SOCIAL_RE,
    ADDRESS_RE,
  },
};
