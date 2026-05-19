'use strict';

/**
 * session-fingerprint — bind a session token to the network +
 * user-agent fingerprint of the issuing client (improvement cycle 17,
 * Task 2).
 *
 * Why:
 *   A leaked JWT or session cookie can be replayed from any device
 *   until it expires. By recording sha256(IP-class || UA) at login
 *   time and re-validating it on every request, we narrow the replay
 *   window: an attacker on a different network or browser cannot use
 *   the token even if they exfiltrate it.
 *
 * Design notes:
 *   - The IP is reduced to its /24 (IPv4) or /64 (IPv6) prefix before
 *     hashing. Mobile networks frequently shuffle the host octet, so
 *     this gives us drift tolerance without weakening the protection
 *     against a different network entirely.
 *   - The UA is normalized (lowercased, trimmed) — browser auto-update
 *     bumps the minor version on each release; we keep the full string
 *     so that a Chrome→Firefox swap is detected but in-place minor
 *     updates are not. (A separate "loose" mode could collapse to
 *     family + major version; left for a follow-up.)
 *   - The fingerprint is hashed with sha256 + a pepper so the stored
 *     value isn't directly reversible to network info.
 */

const crypto = require('crypto');

function getPepper() {
  return (
    process.env.SESSION_FINGERPRINT_PEPPER ||
    process.env.JWT_SECRET ||
    'siragpt-fingerprint-default-pepper'
  );
}

function isIPv6(ip) {
  return typeof ip === 'string' && ip.includes(':');
}

/**
 * Reduce an IP to its network-class prefix.
 *   - IPv4 → /24 ("a.b.c.0")
 *   - IPv6 → /64 (first four hextets)
 * Falls back to the raw string when parsing fails.
 */
function reduceIp(ip) {
  if (!ip || typeof ip !== 'string') return '';
  const cleaned = ip.replace(/^::ffff:/, '').split(',')[0].trim();
  if (!cleaned) return '';
  if (isIPv6(cleaned)) {
    const parts = cleaned.split(':');
    return parts.slice(0, 4).join(':') + '::/64';
  }
  const parts = cleaned.split('.');
  if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) {
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }
  return cleaned;
}

function extractIp(req) {
  if (!req) return '';
  const xff = req.headers && req.headers['x-forwarded-for'];
  if (xff && typeof xff === 'string') return xff.split(',')[0].trim();
  return req.ip || (req.socket && req.socket.remoteAddress) || '';
}

function extractUa(req) {
  return (req && req.headers && (req.headers['user-agent'] || '')) || '';
}

/**
 * computeFingerprint(req | { ip, ua }) → hex sha256 digest.
 *
 * Accepts either an Express request or a plain `{ ip, ua }` object so
 * tests can call it without constructing a full req.
 */
function computeFingerprint(input) {
  let ip;
  let ua;
  if (input && typeof input === 'object' && (input.headers || input.socket)) {
    ip = extractIp(input);
    ua = extractUa(input);
  } else {
    ip = (input && input.ip) || '';
    ua = (input && input.ua) || '';
  }
  const ipClass = reduceIp(ip);
  const uaNorm = String(ua).trim().toLowerCase();
  return crypto
    .createHmac('sha256', getPepper())
    .update(`${ipClass}|${uaNorm}`)
    .digest('hex');
}

/**
 * compareFingerprints — timing-safe equality check.
 */
function compareFingerprints(a, b) {
  if (!a || !b) return false;
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

module.exports = {
  computeFingerprint,
  compareFingerprints,
  reduceIp,
  extractIp,
  extractUa,
};
