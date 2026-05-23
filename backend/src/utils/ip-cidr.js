'use strict';

/**
 * ip-cidr — IPv4 + IPv6 CIDR membership without deps. Pairs with the
 * RBAC scope matcher (#68), token-bucket limiter (#31), and the
 * audit log (#14): allowlists / blocklists / per-CIDR limits all
 * need this primitive.
 *
 * Public API:
 *   parseIp(str)                     → BigInt | null
 *   parseCidr(str)                   → { base, bits, version } | null
 *   cidrContains(cidr, ipStr)        → boolean
 *   anyContains(cidrList, ipStr)     → boolean
 *   isValidIp / isValidCidr
 */

function parseIPv4(str) {
  const parts = str.split('.');
  if (parts.length !== 4) return null;
  let v = 0n;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const n = Number(p);
    if (n < 0 || n > 255) return null;
    v = (v << 8n) | BigInt(n);
  }
  return v;
}

function parseIPv6(str) {
  // Reject port suffix and zone id for safety.
  if (str.includes('%')) str = str.slice(0, str.indexOf('%'));
  // Split on '::' to handle the run-of-zeros shorthand.
  const dcIdx = str.indexOf('::');
  let head = '', tail = '';
  if (dcIdx === -1) {
    head = str;
  } else {
    head = str.slice(0, dcIdx);
    tail = str.slice(dcIdx + 2);
    if (str.indexOf('::', dcIdx + 1) !== -1) return null; // only one ::
  }
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const total = 8;
  if (headParts.length + tailParts.length > total) return null;
  const zeros = total - headParts.length - tailParts.length;
  if (dcIdx === -1 && headParts.length !== total) return null;
  const all = [...headParts, ...new Array(zeros).fill('0'), ...tailParts];
  if (all.length !== total) return null;
  let v = 0n;
  for (const p of all) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(p)) return null;
    v = (v << 16n) | BigInt(parseInt(p, 16));
  }
  return v;
}

function parseIp(str) {
  if (typeof str !== 'string' || !str) return null;
  if (str.includes(':')) {
    const v = parseIPv6(str);
    return v == null ? null : { value: v, version: 6 };
  }
  const v = parseIPv4(str);
  return v == null ? null : { value: v, version: 4 };
}

function parseCidr(str) {
  if (typeof str !== 'string' || !str.includes('/')) return null;
  const [ipStr, bitsStr] = str.split('/');
  const ip = parseIp(ipStr);
  if (!ip) return null;
  const bits = Number(bitsStr);
  const max = ip.version === 4 ? 32 : 128;
  if (!Number.isInteger(bits) || bits < 0 || bits > max) return null;
  // Mask the IP down to its network base (we ignore host bits).
  const total = max;
  const hostBits = total - bits;
  const mask = hostBits === 0 ? ((1n << BigInt(total)) - 1n) : (((1n << BigInt(bits)) - 1n) << BigInt(hostBits));
  return { base: ip.value & mask, bits, version: ip.version, mask };
}

function cidrContains(cidr, ipStr) {
  const c = typeof cidr === 'string' ? parseCidr(cidr) : cidr;
  if (!c) return false;
  const ip = parseIp(ipStr);
  if (!ip || ip.version !== c.version) return false;
  return (ip.value & c.mask) === c.base;
}

function anyContains(cidrList, ipStr) {
  if (!Array.isArray(cidrList)) return false;
  for (const c of cidrList) if (cidrContains(c, ipStr)) return true;
  return false;
}

function isValidIp(str) { return parseIp(str) != null; }
function isValidCidr(str) { return parseCidr(str) != null; }

module.exports = {
  parseIp,
  parseCidr,
  cidrContains,
  anyContains,
  isValidIp,
  isValidCidr,
};
