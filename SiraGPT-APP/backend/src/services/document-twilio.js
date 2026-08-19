'use strict';

/**
 * document-twilio.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects Twilio SDK usage and SIDs. All SIDs are MASKED (prefix + last 4).
 *
 *   SID prefixes (object types):
 *     AC = Account                MM = Messaging Service
 *     SM = Message                CA = Call
 *     PN = Phone Number           RE = Recording
 *     SE = Sandbox               FN = Function
 *     SI = Service                VA = Verify Service
 *     KS = Sync Service           CH = Channel
 *     IS = Conversation Service   PV = Phone Number Verification
 *     MG = Message                NO = Notify Service
 *
 *   Methods:  twilio.messages / .calls / .verify / .voice / .conversations
 *             .create() / .fetch() / .update() / .remove() / .list()
 *
 *   TwiML:    <Response> / <Say> / <Play> / <Dial> / <Gather> / <Record> /
 *             <Hangup> / <Pause> / <Redirect> / <Reject> / <Connect> / <Stream>
 *
 *   Signature: X-Twilio-Signature header reference
 *
 * Public API:
 *   extractTwilio(text)             → { entries, totals, total }
 *   buildTwilioForFiles(files)      → { perFile, aggregate, totals }
 *   renderTwilioBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 22;
const MAX_AGGREGATE = 28;
const MAX_BLOCK_CHARS = 4800;

const SID_PREFIXES = {
  AC: 'account',
  MM: 'messagingService',
  SM: 'message',
  MG: 'message',
  CA: 'call',
  PN: 'phoneNumber',
  RE: 'recording',
  SE: 'sandbox',
  FN: 'function',
  SI: 'service',
  VA: 'verifyService',
  KS: 'syncService',
  CH: 'channel',
  IS: 'conversationService',
  PV: 'phoneVerification',
  NO: 'notifyService',
  VE: 'verification',
  US: 'userBinding',
  HR: 'role',
  AP: 'application',
  CR: 'credential',
  WA: 'workflowAttempt',
  IP: 'ipMessaging',
  SK: 'apiKey',
  TQ: 'taskQueue',
};

const SID_RE = /\b([A-Z]{2})([a-f0-9]{30,40})\b/g;
const RESOURCE_RE = /\b(?:twilio|client)\.(messages|calls|verify|voice|conversations|chat|video|sync|monitor|notify|insights|wireless|pricing|trunking|taskrouter|programmable|lookups|fax|api|incomingPhoneNumbers|outgoingCallerIds|usage|accounts|tokens|applications|recordings|transcriptions|queues|conferences|notifications)\b/g;
const METHOD_RE = /\b(?:messages|calls|verify|voice|conversations|chat)\.(create|fetch|update|remove|delete|list|each|stream)\s*\(/g;
const TWIML_VERB_RE = /<(Response|Say|Play|Dial|Gather|Record|Hangup|Pause|Redirect|Reject|Connect|Stream|Number|Sip|Sms|Conference|Queue|Client|Enqueue|Leave|Refer|Start|Stop|Identify|Application|Task|Body|Pay|Prompt|Parameter|Echo)(?:\s|\/|>)/g;
const SIGNATURE_RE = /\bX-Twilio-Signature\b|twilio\.RequestValidator|validateRequest/g;
const WEBHOOK_RE = /["']https?:\/\/[^"'\n]*?(?:twilio|twiml)[^"'\n]{0,80}["']/g;

function maskSid(prefix, suffix) {
  if (suffix.length <= 8) return `${prefix}${suffix}`;
  return `${prefix}…${suffix.slice(-4)}`;
}

function isTwilioLike(body) {
  return /\btwilio\b|@twilio\/|require\(['"]twilio['"]\)|<Response>|TwilioRestClient|X-Twilio-Signature|RequestValidator|\b(?:AC|SM|MM|CA|PN|VA|MG)[a-f0-9]{30,40}\b/.test(body);
}

function extractTwilio(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  if (!isTwilioLike(body)) {
    return { entries: [], totals: {}, total: 0 };
  }
  const seen = new Set();
  const entries = [];
  const totals = {
    sid: 0, resource: 0, method: 0, twimlVerb: 0,
    signature: 0, webhook: 0,
  };
  // Per-object-type counts under sid kind
  const sidByType = {};

  function push(kind, name, detail) {
    const sig = `${kind}:${name}:${detail || ''}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    entries.push({ kind, name, detail });
    if (totals[kind] != null) totals[kind] += 1;
  }

  SID_RE.lastIndex = 0;
  let m;
  while ((m = SID_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const prefix = m[1];
    const type = SID_PREFIXES[prefix];
    if (!type) continue;
    const masked = maskSid(prefix, m[2]);
    push('sid', masked, type);
    sidByType[type] = (sidByType[type] || 0) + 1;
  }
  if (entries.length < MAX_PER_FILE) {
    RESOURCE_RE.lastIndex = 0;
    while ((m = RESOURCE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('resource', `twilio.${m[1]}`, null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    METHOD_RE.lastIndex = 0;
    while ((m = METHOD_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('method', `.${m[1]}`, null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    TWIML_VERB_RE.lastIndex = 0;
    while ((m = TWIML_VERB_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('twimlVerb', `<${m[1]}>`, null);
    }
  }

  let sigCount = 0;
  SIGNATURE_RE.lastIndex = 0;
  while (SIGNATURE_RE.exec(body) && sigCount < 5) sigCount += 1;
  totals.signature = sigCount;
  if (sigCount && entries.length < MAX_PER_FILE) {
    entries.push({ kind: 'signature', name: 'X-Twilio-Signature', detail: `${sigCount} ref(s)` });
  }

  if (entries.length < MAX_PER_FILE) {
    WEBHOOK_RE.lastIndex = 0;
    while ((m = WEBHOOK_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const url = m[0].replace(/^["']|["']$/g, '').slice(0, 80);
      push('webhook', url, null);
    }
  }

  return { entries, totals, total: entries.length };
}

function buildTwilioForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {
    sid: 0, resource: 0, method: 0, twimlVerb: 0,
    signature: 0, webhook: 0,
  };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractTwilio(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.name}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      if (totals[e.kind] != null) totals[e.kind] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderTwilioBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## TWILIO API'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 14)) {
      const det = e.detail ? ` (${e.detail})` : '';
      lines.push(`- [${e.kind}] \`${e.name}\`${det}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractTwilio,
  buildTwilioForFiles,
  renderTwilioBlock,
  _internal: { maskSid, isTwilioLike, SID_PREFIXES },
};
