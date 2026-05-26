'use strict';

/**
 * accept-negotiator — RFC 7231 §5.3.2 Accept header parser + content
 * negotiation. Pairs with the ETag helpers (#87) and resilient fetch
 * (#61): when an endpoint can serve multiple representations
 * (application/json vs text/event-stream vs text/html), this picks
 * the right one based on the client's Accept header.
 *
 * Algorithm:
 *   1. Parse client Accept into [{ type, subtype, q, params }] entries.
 *   2. For each server type, find the best-matching client entry by
 *      specificity (exact > type/* > * /*), tie-broken by q-value.
 *   3. Return the server type with the highest (specificity, q*serverWeight)
 *      product. Null when nothing matches.
 *
 * Public API:
 *   parseAccept(header)              → entries[]
 *   negotiate(serverTypes, header)   → string | null
 *     serverTypes can be:
 *       - array of strings ['application/json', 'text/html']
 *       - array of [type, weight] pairs (server preference 0..1)
 *
 *   isMatch(clientEntry, serverType) → boolean   (exposed helper)
 */

function parseAccept(header) {
  if (typeof header !== 'string' || !header.trim()) return [{ type: '*', subtype: '*', q: 1, params: {} }];
  return header.split(',').map((raw) => {
    const parts = raw.trim().split(';').map((s) => s.trim()).filter(Boolean);
    const head = parts[0] || '*/*';
    let [type, subtype] = head.split('/');
    if (!subtype) { subtype = type; type = '*'; }
    type = (type || '*').toLowerCase();
    subtype = (subtype || '*').toLowerCase();
    const params = {};
    let q = 1;
    for (const p of parts.slice(1)) {
      const eq = p.indexOf('=');
      if (eq === -1) continue;
      const k = p.slice(0, eq).trim().toLowerCase();
      const v = p.slice(eq + 1).trim();
      if (k === 'q') {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 0 && n <= 1) q = n;
      } else {
        params[k] = v;
      }
    }
    return { type, subtype, q, params };
  });
}

function isMatch(client, serverType) {
  if (typeof serverType !== 'string' || !serverType.includes('/')) return false;
  const [t, s] = serverType.toLowerCase().split('/');
  if (client.type !== '*' && client.type !== t) return false;
  if (client.subtype !== '*' && client.subtype !== s) return false;
  return true;
}

function specificity(client) {
  if (client.type === '*' && client.subtype === '*') return 0;
  if (client.subtype === '*') return 1;
  return 2;
}

function negotiate(serverTypes, header) {
  if (!Array.isArray(serverTypes) || serverTypes.length === 0) return null;
  const entries = parseAccept(header);

  let bestType = null;
  let bestScore = -1;
  for (const entry of serverTypes) {
    const [type, weight] = Array.isArray(entry) ? entry : [entry, 1];
    if (typeof type !== 'string') continue;
    let bestForType = null;
    let bestSpec = -1;
    for (const c of entries) {
      if (c.q === 0) continue;
      if (!isMatch(c, type)) continue;
      const spec = specificity(c);
      if (spec > bestSpec || (spec === bestSpec && (!bestForType || c.q > bestForType.q))) {
        bestForType = c;
        bestSpec = spec;
      }
    }
    if (!bestForType) continue;
    const score = bestForType.q * (Number.isFinite(weight) ? weight : 1) + bestSpec * 0.001;
    if (score > bestScore) {
      bestScore = score;
      bestType = type;
    }
  }
  return bestType;
}

module.exports = {
  parseAccept,
  negotiate,
  isMatch,
};
