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

/**
 * Look up whether `domain` is bound to a RUNNING full-stack Node-app deployment
 * (container behind Caddy). Used so Caddy issues certs for Node-app domains
 * that have no static `index.html` folder. Best-effort: returns false on any
 * error (no cert) rather than throwing.
 */
async function defaultLookupNodeDomain(domain) {
  let prisma;
  try {
    prisma = require('../../config/database');
  } catch {
    return false;
  }
  if (!prisma || !prisma.deploymentDomain || !prisma.deployment) return false;
  const dom = await prisma.deploymentDomain.findFirst({ where: { hostname: domain } });
  if (!dom) return false;
  const dep = await prisma.deployment.findFirst({
    where: { id: dom.deploymentId, deletedAt: null, status: 'running', deploymentType: 'hostinger_vps' },
  });
  return Boolean(dep);
}

/**
 * Async gate used by the Caddy on-demand-TLS endpoint: allow a domain that has
 * EITHER a deployed static site (fast-path, filesystem) OR a running Node-app
 * deployment (DB lookup). `lookupNodeDomain` is injectable for offline tests.
 */
async function isDomainAllowedAsync(domain, { env = process.env, fsImpl = fs, lookupNodeDomain = defaultLookupNodeDomain } = {}) {
  const d = String(domain || '').trim().toLowerCase();
  if (!d || d.length > 253 || d.includes('..') || !PUBLISH_DOMAIN_RE.test(d)) return false;
  if (isDomainAllowed(d, { env, fsImpl })) return true; // static fast-path (no DB)
  try {
    return Boolean(await lookupNodeDomain(d));
  } catch {
    return false;
  }
}

module.exports = { isDomainAllowed, isDomainAllowedAsync, defaultLookupNodeDomain, publishedSitesDir, PUBLISH_DOMAIN_RE };
