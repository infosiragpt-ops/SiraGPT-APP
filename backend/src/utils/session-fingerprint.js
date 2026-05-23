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
const net = require('net');

const MAX_IP_INPUT_LENGTH = 128;
const MAX_UA_LENGTH = 512;

function getPepper() {
  return (
    process.env.SESSION_FINGERPRINT_PEPPER ||
    process.env.JWT_SECRET ||
    'siragpt-fingerprint-default-pepper'
  );
}

function firstHeaderValue(value) {
  if (Array.isArray(value)) return value[0];
  return value;
}

function normalizeIpInput(value) {
  const first = firstHeaderValue(value);
  if (first == null) return '';
  const cleaned = String(first)
    .split(',')[0]
    .trim()
    .replace(/^::ffff:/i, '')
    .split('%')[0];
  if (!cleaned || cleaned.length > MAX_IP_INPUT_LENGTH) return '';
  if (/[\r\n\0]/.test(cleaned)) return '';
  return cleaned;
}

function normalizeUserAgent(value) {
  const first = firstHeaderValue(value);
  if (first == null) return '';
  return String(first)
    .replace(/[\r\n\0]+/g, ' ')
    .trim()
    .slice(0, MAX_UA_LENGTH);
}

function isIPv6(ip) {
  return typeof ip === 'string' && ip.includes(':');
}

function expandIPv6(ip) {
  const compact = String(ip || '').toLowerCase();
  const [headRaw = '', tailRaw = ''] = compact.split('::');
  const head = headRaw ? headRaw.split(':') : [];
  const tail = tailRaw ? tailRaw.split(':') : [];
  const missing = Math.max(0, 8 - head.length - tail.length);
  return [...head, ...Array(missing).fill('0'), ...tail].map(part => (part || '0').padStart(4, '0'));
}

function trimHextet(part) {
  return String(part || '0').replace(/^0+/, '') || '0';
}

/**
 * Reduce an IP to its network-class prefix.
 *   - IPv4 → /24 ("a.b.c.0")
 *   - IPv6 → /64 (first four hextets)
 * Falls back to the raw string when parsing fails.
 */
function reduceIp(ip) {
  const cleaned = normalizeIpInput(ip);
  if (!cleaned) return '';
  const ipKind = net.isIP(cleaned);
  if (ipKind === 6 || isIPv6(cleaned)) {
    if (ipKind !== 6) return cleaned;
    const parts = expandIPv6(cleaned);
    return parts.slice(0, 4).map(trimHextet).join(':') + '::/64';
  }
  const parts = cleaned.split('.');
  if (ipKind === 4 && parts.length === 4) {
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }
  return cleaned;
}

function extractIp(req) {
  if (!req) return '';
  const xff = req.headers && req.headers['x-forwarded-for'];
  return normalizeIpInput(xff)
    || normalizeIpInput(req.ip)
    || normalizeIpInput(req.socket && req.socket.remoteAddress)
    || '';
}

function extractUa(req) {
  return normalizeUserAgent(req && req.headers && req.headers['user-agent']);
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
    ip = normalizeIpInput(input && input.ip);
    ua = normalizeUserAgent(input && input.ua);
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
  normalizeIpInput,
  normalizeUserAgent,
  MAX_IP_INPUT_LENGTH,
  MAX_UA_LENGTH,
};
