'use strict';

/**
 * First-party ChatGPT-style app manifests for /conexiones Phase 1.
 * App ≠ plugin ≠ skill ≠ tool ≠ MCP server ≠ widget ≠ connection ≠ workflow.
 */

const APP_IDS = Object.freeze(['github', 'linkedin', 'x']);

const STATUSES = Object.freeze({
  CONNECTED: 'connected',
  DEGRADED: 'degraded',
  EXPIRED: 'expired',
  MISSING_SCOPES: 'missing_scopes',
  REVOKED: 'revoked',
  ERROR: 'error',
});

const SECRET_KINDS = Object.freeze({
  GITHUB_ACCOUNT: 'github_account',
  SOCIAL_CONNECTION: 'social_connection',
});

const APPS = Object.freeze({
  github: Object.freeze({
    id: 'github',
    name: 'GitHub',
    auth: 'oauth2',
    risk: 'write',
    connectPath: '/github/connect',
    callbackPath: '/api/github/callback',
    minScopes: Object.freeze(['read:user']),
    writeScopes: Object.freeze(['repo']),
    tools: Object.freeze([
      Object.freeze({
        name: 'github_list_repos',
        kind: 'read',
        risk: 'read',
        description: 'List repositories the connected GitHub account can access.',
      }),
      Object.freeze({
        name: 'github_create_issue',
        kind: 'write',
        risk: 'write',
        requiresApproval: true,
        description: 'Create a GitHub issue. Requires explicit approval.',
      }),
    ]),
  }),
  linkedin: Object.freeze({
    id: 'linkedin',
    name: 'LinkedIn',
    auth: 'oauth2',
    risk: 'write',
    connectPath: '/social-posts/connect/linkedin',
    callbackPath: '/api/social-posts/oauth/linkedin/callback',
    minScopes: Object.freeze(['openid', 'profile']),
    writeScopes: Object.freeze(['w_member_social']),
    tools: Object.freeze([
      Object.freeze({
        name: 'linkedin_read_profile',
        kind: 'read',
        risk: 'read',
        description: 'Read the connected LinkedIn profile (OpenID userinfo).',
      }),
      Object.freeze({
        name: 'linkedin_publish_post',
        kind: 'write',
        risk: 'write',
        requiresApproval: true,
        description: 'Publish a LinkedIn post. Requires explicit approval.',
      }),
    ]),
  }),
  x: Object.freeze({
    id: 'x',
    name: 'X',
    auth: 'oauth2_pkce',
    risk: 'write',
    connectPath: '/social-posts/connect/x',
    callbackPath: '/api/social-posts/oauth/x/callback',
    minScopes: Object.freeze(['users.read', 'tweet.read']),
    writeScopes: Object.freeze(['tweet.write']),
    tools: Object.freeze([
      Object.freeze({
        name: 'x_list_mentions',
        kind: 'read',
        risk: 'read',
        description: 'List recent mentions for the connected X account.',
      }),
      Object.freeze({
        name: 'x_publish_post',
        kind: 'write',
        risk: 'write',
        requiresApproval: true,
        description: 'Publish a post on X. Requires explicit approval.',
      }),
    ]),
  }),
});

function normalizeAppId(value) {
  const id = String(value || '').trim().toLowerCase();
  if (id === 'twitter') return 'x';
  return APP_IDS.includes(id) ? id : null;
}

function getManifest(appId) {
  const id = normalizeAppId(appId);
  return id ? APPS[id] : null;
}

function listManifests() {
  return APP_IDS.map((id) => APPS[id]);
}

function publicManifest(app) {
  if (!app) return null;
  return {
    id: app.id,
    name: app.name,
    auth: app.auth,
    risk: app.risk,
    connectPath: app.connectPath,
    minScopes: [...app.minScopes],
    tools: app.tools.map((tool) => ({
      name: tool.name,
      kind: tool.kind,
      risk: tool.risk,
      requiresApproval: Boolean(tool.requiresApproval),
      description: tool.description,
    })),
  };
}

function toolByName(name) {
  const needle = String(name || '').trim();
  for (const app of listManifests()) {
    const tool = app.tools.find((entry) => entry.name === needle);
    if (tool) return { app, tool };
  }
  return null;
}

function secretRef(kind, id) {
  return `${kind}:${id}`;
}

function parseSecretRef(ref) {
  const raw = String(ref || '');
  const sep = raw.indexOf(':');
  if (sep <= 0) return null;
  const kind = raw.slice(0, sep);
  const id = raw.slice(sep + 1).trim();
  if (!id) return null;
  if (kind !== SECRET_KINDS.GITHUB_ACCOUNT && kind !== SECRET_KINDS.SOCIAL_CONNECTION) {
    return null;
  }
  return { kind, id };
}

module.exports = {
  APP_IDS,
  APPS,
  STATUSES,
  SECRET_KINDS,
  normalizeAppId,
  getManifest,
  listManifests,
  publicManifest,
  toolByName,
  secretRef,
  parseSecretRef,
};
