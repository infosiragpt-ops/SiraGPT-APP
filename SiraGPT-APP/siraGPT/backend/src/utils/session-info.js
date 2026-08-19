'use strict';

/**
 * session-info — tiny helpers used by `/api/auth/sessions` to render an
 * active-session row safely:
 *
 *   • `maskIp(ip)` — collapses the host octet/hextet of an IPv4/IPv6
 *     address so users only see the broad network range instead of
 *     the full client IP. Avoids leaking precise location data when
 *     a user inspects their own session list.
 *   • `parseUA(ua)` — extracts {browser, os, device} from a User-Agent
 *     string using narrow keyword heuristics (no external dep).
 *
 * Both functions are TOTAL: any unparseable / falsy input yields a
 * stable shape so the route never throws on weird stored data.
 */

function maskIp(input) {
  if (!input || typeof input !== 'string') return null;
  // Drop port suffixes like "1.2.3.4:53124" and IPv6 zone ids.
  let ip = input.trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice('::ffff:'.length);
  const portIdx = ip.lastIndexOf(':');
  if (ip.indexOf('.') !== -1 && portIdx !== -1) ip = ip.slice(0, portIdx);

  // IPv4 → drop last octet (e.g. 198.51.100.x).
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.x`;

  // IPv6 → keep the first 3 hextets, mask the rest.
  if (ip.includes(':')) {
    const head = ip.split(':').slice(0, 3).join(':');
    return `${head}::x`;
  }

  // Unknown shape — return a redacted placeholder so we don't leak it.
  return 'unknown';
}

const BROWSERS = [
  ['Edg/', 'Edge'],
  ['OPR/', 'Opera'],
  ['Chrome/', 'Chrome'],
  ['Firefox/', 'Firefox'],
  ['Safari/', 'Safari'],
  ['MSIE ', 'IE'],
  ['Trident/', 'IE'],
];
const OSES = [
  ['Windows NT 10', 'Windows 10'],
  ['Windows NT 6.3', 'Windows 8.1'],
  ['Windows NT 6.2', 'Windows 8'],
  ['Windows NT 6.1', 'Windows 7'],
  // iPhone/iPad UAs also contain "Mac OS X" — match the device tokens
  // first so iOS/iPadOS win over the generic macOS label.
  ['iPad', 'iPadOS'],
  ['iPhone', 'iOS'],
  ['iPod', 'iOS'],
  ['Android', 'Android'],
  ['Mac OS X', 'macOS'],
  ['Linux', 'Linux'],
];

function parseUA(ua) {
  if (!ua || typeof ua !== 'string') {
    return { browser: 'Unknown', os: 'Unknown', device: 'desktop', raw: null };
  }
  let browser = 'Unknown';
  for (const [needle, label] of BROWSERS) {
    if (ua.includes(needle)) { browser = label; break; }
  }
  // Chrome ships UA tokens for both Chrome and Safari — Safari must
  // only win when Chrome is absent.
  if (browser === 'Safari' && ua.includes('Chrome/')) browser = 'Chrome';

  let os = 'Unknown';
  for (const [needle, label] of OSES) {
    if (ua.includes(needle)) { os = label; break; }
  }

  let device = 'desktop';
  if (/Mobi|Android|iPhone|iPad|iPod/i.test(ua)) device = 'mobile';
  if (/iPad|Tablet/i.test(ua)) device = 'tablet';

  // Cap the raw UA we echo back so a hostile UA can't blow up the JSON.
  const raw = ua.length > 200 ? `${ua.slice(0, 200)}…` : ua;
  return { browser, os, device, raw };
}

module.exports = { maskIp, parseUA };
