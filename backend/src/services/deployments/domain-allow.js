'use strict';

/**
 * deployments/domain-allow — the gate Caddy's `on_demand_tls { ask … }` calls
 * before issuing a TLS cert for a user-published custom domain.
 *
 * A domain is allowed ONLY if it has an actually-deployed static site
 * (an index.html) under the published-sites base directory. That base is
 * PUBLISHED_SITES_DIR (default `/srv/sites`, which maps to the host's
 * `/var/www/published-sites`) — a directory completely separate from the
 * SiraGPT app, so publishing user sites can never touch or break SiraGPT.
 *
 * Returning allowed:false (→ HTTP 403 at the route) makes Caddy refuse the
 * cert, which prevents arbitrary domains pointed at the VPS from minting certs.
 */

const fs = require('node:fs');
const path = require('node:path');

// A conservative hostname: labels of [a-z0-9-] (no leading/trailing hyphen),
// at least two labels (needs a TLD). No slashes, no "..", lowercase only.
const PUBLISH_DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function publishedSitesDir(env = process.env) {
  return env.PUBLISHED_SITES_DIR || '/srv/sites';
}

/**
 * Is `domain` allowed an on-demand TLS cert? True only when a deployed site
 * folder (with index.html) exists for it under the published-sites base.
 * `fsImpl`/`env` are injectable for offline tests.
 */
function isDomainAllowed(domain, { env = process.env, fsImpl = fs } = {}) {
  const d = String(domain || '').trim().toLowerCase();
  if (!d || d.length > 253 || d.includes('..') || !PUBLISH_DOMAIN_RE.test(d)) return false;
  const base = path.resolve(publishedSitesDir(env));
  const dir = path.resolve(base, d);
  // Containment: the resolved path must stay inside the base directory.
  if (dir !== path.join(base, d) || !dir.startsWith(base + path.sep)) return false;
  try {
    return fsImpl.existsSync(path.join(dir, 'index.html'));
  } catch {
    return false;
  }
}

module.exports = { isDomainAllowed, publishedSitesDir, PUBLISH_DOMAIN_RE };
