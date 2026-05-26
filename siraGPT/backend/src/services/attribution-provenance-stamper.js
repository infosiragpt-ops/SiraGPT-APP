'use strict';

/**
 * attribution-provenance-stamper.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Mints a small cryptographic provenance stamp for every assistant
 * response. The stamp binds together:
 *
 *   • a deterministic hash of the input prompt
 *   • a deterministic hash of the system-prompt block bundle that drove
 *     the response (the attribution graph context)
 *   • a SHA-256 of the output response text
 *   • the module-version fingerprints of the active attribution stack
 *   • a server-side HMAC over the bundle so admin tools can later
 *     verify "this stamp came from our system, unmodified"
 *
 * The stamp is JSON-safe and lightweight (~ 200 bytes). It can be
 * dropped into a response trailer, returned in a header
 * (`x-sira-provenance: …`), or attached as metadata to a message
 * record for forensic / audit purposes.
 *
 * Public API:
 *   stamp({ prompt, systemBlocks, response, modules?, opts? })
 *       → ProvenanceStamp
 *   verify(stamp, { prompt, systemBlocks, response, secret? })
 *       → VerificationReport
 *   hashText(text)            → hex string
 *   moduleFingerprint(name?)  → string
 *
 * Tunables (env):
 *   SIRAGPT_PROVENANCE_SECRET            — HMAC key (string)
 *   SIRAGPT_PROVENANCE_DISABLED          — '1' → returns null instead of a stamp
 */

const crypto = require('node:crypto');

const DISABLED = String(process.env.SIRAGPT_PROVENANCE_DISABLED || '').toLowerCase() === '1';
const SECRET = process.env.SIRAGPT_PROVENANCE_SECRET || 'sira-default-provenance-secret';
const STAMP_VERSION = 'sira-prov-v1';

// Lazily compute a per-process module fingerprint that captures the
// loaded module names — useful for "did the orchestrator drift?" diffs
// in admin tooling.
let _moduleFp = null;
function moduleFingerprint(name) {
  if (name) return crypto.createHash('sha256').update(`${STAMP_VERSION}::${name}`).digest('hex').slice(0, 12);
  if (_moduleFp) return _moduleFp;
  const names = [
    'attribution-graph', 'intent-attribution-graph', 'context-attribution-engine',
    'saliency-decay-tracker', 'attribution-cache', 'prompt-budget-allocator',
    'ambiguity-flagger', 'adversarial-prompt-detector', 'self-reflection-loop',
    'cross-modal-attribution', 'domain-calibration', 'attribution-snapshot-store',
  ];
  _moduleFp = crypto.createHash('sha256').update(names.sort().join('|')).digest('hex').slice(0, 16);
  return _moduleFp;
}

function hashText(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

function hashSystemBlocks(systemBlocks) {
  if (!Array.isArray(systemBlocks)) return hashText(JSON.stringify(systemBlocks || null));
  const canonical = systemBlocks
    .filter((b) => b && (b.text || b.kind))
    .map((b) => `${b.kind || 'block'}::${b.text || ''}`)
    .join('\n');
  return hashText(canonical);
}

function hmac(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function stamp({ prompt = '', systemBlocks = [], response = '', modules = null, opts = {} } = {}) {
  if (DISABLED) return null;
  const promptHash = hashText(prompt);
  const blocksHash = hashSystemBlocks(systemBlocks);
  const responseHash = hashText(response);
  const moduleFp = modules ? moduleFingerprint(modules.join('|')) : moduleFingerprint();
  const ts = Date.now();
  const payload = [STAMP_VERSION, ts, promptHash, blocksHash, responseHash, moduleFp].join('::');
  const secret = opts.secret || SECRET;
  const signature = hmac(secret, payload);
  return {
    version: STAMP_VERSION,
    ts,
    promptHash: promptHash.slice(0, 24),
    blocksHash: blocksHash.slice(0, 24),
    responseHash: responseHash.slice(0, 24),
    moduleFp,
    signature: signature.slice(0, 32),
  };
}

function verify(receivedStamp, { prompt = '', systemBlocks = [], response = '', secret } = {}) {
  if (!receivedStamp) return { ok: false, reason: 'stamp missing' };
  if (receivedStamp.version !== STAMP_VERSION) return { ok: false, reason: 'unknown version' };
  const recomputed = stamp({ prompt, systemBlocks, response, opts: { secret } });
  if (!recomputed) return { ok: false, reason: 'provenance disabled' };
  // Compare component-wise so we can report exactly which field broke.
  const mismatches = [];
  if (recomputed.promptHash !== receivedStamp.promptHash) mismatches.push('promptHash');
  if (recomputed.blocksHash !== receivedStamp.blocksHash) mismatches.push('blocksHash');
  if (recomputed.responseHash !== receivedStamp.responseHash) mismatches.push('responseHash');
  if (recomputed.moduleFp !== receivedStamp.moduleFp) mismatches.push('moduleFp');
  // signature compare is timing-safe but only if both buffers are the
  // same length — receivedStamp.signature is the trusted-length string.
  const sigOk = receivedStamp.signature && recomputed.signature &&
                receivedStamp.signature.length === recomputed.signature.length &&
                crypto.timingSafeEqual(Buffer.from(recomputed.signature), Buffer.from(receivedStamp.signature));
  if (!sigOk) mismatches.push('signature');
  return {
    ok: mismatches.length === 0,
    mismatches,
    expected: recomputed,
    received: receivedStamp,
  };
}

module.exports = {
  stamp,
  verify,
  hashText,
  hashSystemBlocks,
  moduleFingerprint,
  STAMP_VERSION,
};
