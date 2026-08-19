'use strict';

// ──────────────────────────────────────────────────────────────
// siraGPT — SSO Boot Validator (ratchet 44)
// ──────────────────────────────────────────────────────────────
// Defense-in-depth check executed at boot. If we are running in
// production AND at least one org has `ssoEnabled=true` with a
// SAML / OIDC provider configured, but the corresponding upstream
// library (`@node-saml/node-saml` / `openid-client`) is NOT
// installed, emit a loud warning. The SSO callback routes still
// degrade gracefully via the lazy-require pattern in
// `saml-handler.js` / `oidc-handler.js` — this validator surfaces
// the misconfiguration at startup so operators don't first hear
// about it from a failed IdP login.
//
// Non-blocking — never throws, never exits, no UI changes.
// ──────────────────────────────────────────────────────────────

// Cache lib-presence so the lookup is O(1) for the rest of the
// process lifetime. Test-only resetters below.
const libCache = new Map();

function libInstalled(specifier) {
  if (libCache.has(specifier)) return libCache.get(specifier);
  let ok = false;
  try {
    require.resolve(specifier);
    ok = true;
  } catch (_err) {
    ok = false;
  }
  libCache.set(specifier, ok);
  return ok;
}

function __resetLibCacheForTest() {
  libCache.clear();
}

/**
 * Inspect orgs in the DB and warn when prod SSO is enabled but the
 * upstream provider library is not installed.
 *
 * Fire-and-forget — callers MUST NOT await on the result for
 * critical-path startup. All exceptions are swallowed (logged at
 * warn level) so a transient DB hiccup never crashes boot.
 *
 * @param {object} deps
 * @param {object} deps.prisma   - Prisma client (must expose `organization.findMany`)
 * @param {object} deps.logger   - pino-like logger
 * @param {object} [deps.env]    - defaults to process.env (test injection)
 * @param {function} [deps.has]  - presence probe `(specifier) => boolean` (test injection)
 * @returns {Promise<{checked:boolean, warnings:string[]}>}
 */
async function validateActiveSsoConfig(deps = {}) {
  const env = deps.env || process.env;
  const logger = deps.logger || console;
  const has = deps.has || libInstalled;
  const prisma = deps.prisma;

  // Only ever warn in production. Dev/test setups commonly have
  // SAML/OIDC scaffolded without the heavyweight lib installed,
  // and we don't want to spam those logs.
  if (env.NODE_ENV !== 'production') {
    return { checked: false, warnings: [] };
  }

  if (!prisma || !prisma.organization || typeof prisma.organization.findMany !== 'function') {
    return { checked: false, warnings: [] };
  }

  let orgs;
  try {
    orgs = await prisma.organization.findMany({
      where: { ssoEnabled: true },
      select: { id: true, slug: true, ssoConfig: true },
    });
  } catch (err) {
    try {
      logger.warn(
        { err: err && err.message },
        'sso_boot_validator_db_lookup_failed',
      );
    } catch (_logErr) { /* swallow */ }
    return { checked: false, warnings: [] };
  }

  if (!Array.isArray(orgs) || orgs.length === 0) {
    return { checked: true, warnings: [] };
  }

  let samlOrgs = 0;
  let oidcOrgs = 0;
  for (const org of orgs) {
    const provider = org && org.ssoConfig && org.ssoConfig.provider;
    if (provider === 'saml') samlOrgs += 1;
    else if (provider === 'oidc') oidcOrgs += 1;
  }

  const warnings = [];

  if (samlOrgs > 0 && !has('@node-saml/node-saml')) {
    const msg = 'sso_boot_validator_saml_lib_missing';
    try {
      logger.warn(
        {
          orgs: samlOrgs,
          hint: 'install @node-saml/node-saml to handle SAML callbacks',
        },
        msg,
      );
    } catch (_e) { /* swallow */ }
    warnings.push(msg);
  }

  if (oidcOrgs > 0 && !has('openid-client')) {
    const msg = 'sso_boot_validator_oidc_lib_missing';
    try {
      logger.warn(
        {
          orgs: oidcOrgs,
          hint: 'install openid-client to handle OIDC callbacks',
        },
        msg,
      );
    } catch (_e) { /* swallow */ }
    warnings.push(msg);
  }

  return { checked: true, warnings };
}

module.exports = {
  validateActiveSsoConfig,
  __resetLibCacheForTest,
};
