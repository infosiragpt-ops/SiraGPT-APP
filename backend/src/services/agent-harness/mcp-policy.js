'use strict';

const crypto = require('node:crypto');
const net = require('node:net');
const { domainToASCII } = require('node:url');
const { parse: parseDomain } = require('tldts');
const { isProductionLike } = require('../../utils/environment');

const MAX_POLICY_PATTERNS = 100;

class McpPolicyError extends Error {
  constructor(code, status = 403, message = 'MCP server blocked by policy') {
    super(message);
    this.name = 'McpPolicyError';
    this.code = code;
    this.status = status;
  }
}

function parseBoolean(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function stripIpv6Brackets(hostname) {
  return String(hostname || '').replace(/^\[|\]$/g, '');
}

function normalizeHostname(hostname) {
  const raw = stripIpv6Brackets(hostname).trim().replace(/\.+$/g, '');
  if (!raw) throw new McpPolicyError('MCP_HOST_INVALID', 400);
  if (net.isIP(raw)) return raw.toLowerCase();
  const ascii = domainToASCII(raw.normalize('NFC')).toLowerCase().replace(/\.+$/g, '');
  if (!ascii || ascii.length > 253) {
    throw new McpPolicyError('MCP_HOST_INVALID', 400);
  }
  const labels = ascii.split('.');
  if (
    labels.some((label) => (
      !label
      || label.length > 63
      || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    ))
  ) {
    throw new McpPolicyError('MCP_HOST_INVALID', 400);
  }
  return ascii;
}

function isLoopbackIp(hostname) {
  const host = stripIpv6Brackets(hostname).toLowerCase();
  if (net.isIP(host) === 4) return host.startsWith('127.');
  if (net.isIP(host) === 6) {
    return host === '::1' || host === '0:0:0:0:0:0:0:1';
  }
  return false;
}

function isLoopbackHostname(hostname) {
  const host = stripIpv6Brackets(hostname).toLowerCase().replace(/\.+$/g, '');
  return host === 'localhost' || host.endsWith('.localhost') || isLoopbackIp(host);
}

function isPrivateOrReservedIp(hostname) {
  const host = stripIpv6Brackets(hostname).toLowerCase();
  const family = net.isIP(host);
  if (!family) return false;
  if (family === 4) {
    const [a, b, c] = host.split('.').map((part) => Number.parseInt(part, 10));
    return (
      a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0 && c === 0)
      || (a === 192 && b === 0 && c === 2)
      || (a === 192 && b === 88 && c === 99)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113)
      || a >= 224
    );
  }
  if (
    host === '::'
    || isLoopbackIp(host)
    || host.startsWith('fc')
    || host.startsWith('fd')
    || /^fe[89ab]/.test(host)
    || /^fe[cd]/.test(host)
    || host.startsWith('ff')
    || host.startsWith('2001:db8:')
  ) {
    return true;
  }
  // Reuse the canonical SSRF classifier for mapped IPv4, NAT64, and 6to4.
  try {
    const { isPrivateOrReservedAddress } = require('../connectors/web-fetch');
    return isPrivateOrReservedAddress(host);
  } catch (_error) {
    return true;
  }
}

function isPublicDnsHostname(hostname) {
  const parsed = parseDomain(hostname, {
    allowIcannDomains: true,
    allowPrivateDomains: true,
    detectIp: true,
    validateHostname: true,
  });
  return Boolean(parsed && !parsed.isIp && parsed.domain && parsed.publicSuffix);
}

function parseHostPattern(value, { allowLoopback = false } = {}) {
  const input = String(value || '').trim();
  if (!input || /[/?#@:\s]/.test(input)) {
    throw new McpPolicyError('MCP_HOST_PATTERN_INVALID', 400);
  }
  const wildcard = input.startsWith('*.');
  if ((input.includes('*') && !wildcard) || input.slice(2).includes('*')) {
    throw new McpPolicyError('MCP_HOST_PATTERN_INVALID', 400);
  }
  const hostname = normalizeHostname(wildcard ? input.slice(2) : input);
  if (net.isIP(hostname)) {
    throw new McpPolicyError('MCP_HOST_PATTERN_IP_FORBIDDEN', 400);
  }
  if (isLoopbackHostname(hostname)) {
    if (!allowLoopback || wildcard) {
      throw new McpPolicyError('MCP_HOST_PATTERN_PRIVATE', 400);
    }
    return Object.freeze({ kind: 'exact', hostname });
  }
  if (!isPublicDnsHostname(hostname)) {
    throw new McpPolicyError('MCP_HOST_PATTERN_PRIVATE', 400);
  }
  if (wildcard) {
    const parsed = parseDomain(hostname, {
      allowIcannDomains: true,
      allowPrivateDomains: true,
    });
    if (!parsed.domain || parsed.publicSuffix === hostname) {
      throw new McpPolicyError('MCP_WILDCARD_PUBLIC_SUFFIX', 400);
    }
  }
  return Object.freeze({ kind: wildcard ? 'wildcard' : 'exact', hostname });
}

function parsePatternList(values, options = {}) {
  const source = Array.isArray(values)
    ? values
    : String(values || '').split(',');
  if (source.length > MAX_POLICY_PATTERNS) {
    throw new McpPolicyError('MCP_HOST_PATTERN_LIMIT', 400);
  }
  const patterns = [];
  const seen = new Set();
  for (const raw of source) {
    if (typeof raw !== 'string') {
      throw new McpPolicyError('MCP_HOST_PATTERN_INVALID', 400);
    }
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const pattern = parseHostPattern(trimmed, options);
    const key = `${pattern.kind}:${pattern.hostname}`;
    if (!seen.has(key)) {
      seen.add(key);
      patterns.push(pattern);
    }
  }
  return Object.freeze(patterns);
}

function normalizeMcpAllowedHosts(values, options = {}) {
  return parsePatternList(values, options).map((pattern) => (
    pattern.kind === 'wildcard' ? `*.${pattern.hostname}` : pattern.hostname
  ));
}

function hostMatchesPatterns(hostname, patterns) {
  const target = normalizeHostname(hostname);
  return (patterns || []).some((pattern) => (
    pattern.kind === 'exact'
      ? target === pattern.hostname
      : target !== pattern.hostname && target.endsWith(`.${pattern.hostname}`)
  ));
}

function resolveMcpPolicyConfig(env = process.env) {
  const production = isProductionLike(env);
  const configured = Boolean(String(env.SIRAGPT_MCP_ALLOWED_HOSTS || '').trim());
  const errors = [];
  let globalPatterns = [];
  try {
    globalPatterns = parsePatternList(env.SIRAGPT_MCP_ALLOWED_HOSTS, {
      allowLoopback: !production,
    });
  } catch (error) {
    errors.push({ code: error.code || 'MCP_ALLOWED_HOSTS_INVALID' });
  }
  if (production && globalPatterns.length === 0) {
    errors.push({ code: 'MCP_ALLOWED_HOSTS_REQUIRED' });
  }
  if (production && parseBoolean(env.SIRAGPT_MCP_ALLOW_HTTP)) {
    errors.push({ code: 'MCP_HTTP_FORBIDDEN_PRODUCTION' });
  }
  return Object.freeze({
    production,
    configured,
    denyAll: production && !configured,
    valid: errors.length === 0,
    allowHttpLoopback: !production && parseBoolean(env.SIRAGPT_MCP_ALLOW_HTTP),
    globalPatterns,
    allowedHostCount: globalPatterns.length,
    errors: Object.freeze(errors),
  });
}

function rawAuthorityHostname(rawUrl) {
  const match = String(rawUrl || '').match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i);
  if (!match) return '';
  const authority = match[1];
  const withoutUserinfo = authority.slice(authority.lastIndexOf('@') + 1);
  if (withoutUserinfo.startsWith('[')) {
    const close = withoutUserinfo.indexOf(']');
    return close >= 0 ? withoutUserinfo.slice(1, close) : withoutUserinfo;
  }
  return withoutUserinfo.replace(/:\d*$/, '').replace(/\.+$/g, '');
}

function hasAuthorityUserinfoMarker(rawUrl) {
  const match = String(rawUrl || '').match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i);
  return Boolean(match && match[1].includes('@'));
}

function throwInvalidConfig(config) {
  const required = config.errors.some((entry) => entry.code === 'MCP_ALLOWED_HOSTS_REQUIRED');
  throw new McpPolicyError(
    required ? 'MCP_ALLOWED_HOSTS_REQUIRED' : 'MCP_POLICY_CONFIG_INVALID',
    503,
  );
}

function validateMcpServerUrl(rawUrl, { env = process.env, policy = null } = {}) {
  const config = policy && policy.config ? policy.config : resolveMcpPolicyConfig(env);
  if (!config.valid) throwInvalidConfig(config);

  let parsed;
  try {
    parsed = new URL(String(rawUrl || ''));
  } catch (_error) {
    throw new McpPolicyError('MCP_URL_INVALID', 400);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new McpPolicyError('MCP_SCHEME_UNSUPPORTED', 400);
  }
  // WHATWG URL normalizes an empty userinfo segment (`https://@host`) to
  // empty username/password fields. Inspect the raw authority as well so any
  // literal userinfo marker is rejected, including the empty form.
  if (hasAuthorityUserinfoMarker(rawUrl) || parsed.username || parsed.password) {
    throw new McpPolicyError('MCP_USERINFO_FORBIDDEN', 400);
  }
  const hostname = normalizeHostname(parsed.hostname);
  const family = net.isIP(hostname);
  const loopback = isLoopbackHostname(hostname);
  if (family) {
    const rawHost = rawAuthorityHostname(rawUrl).toLowerCase();
    // WHATWG URL parsing intentionally accepts legacy numeric IPv4 forms
    // (decimal integers, octal, shortened quads). Require canonical dotted
    // decimal so those parser tricks can never become an allowed loopback.
    // Equivalent textual IPv6 spellings are safe once normalized to ::1.
    if (family === 4 && rawHost !== hostname) {
      throw new McpPolicyError('MCP_PRIVATE_HOST_FORBIDDEN', 403);
    }
    if (!loopback || parsed.protocol !== 'http:' || !config.allowHttpLoopback) {
      throw new McpPolicyError('MCP_PRIVATE_HOST_FORBIDDEN', 403);
    }
  } else if (loopback) {
    if (parsed.protocol !== 'http:' || !config.allowHttpLoopback) {
      throw new McpPolicyError(
        parsed.protocol === 'http:' ? 'MCP_HTTP_LOOPBACK_DISABLED' : 'MCP_PRIVATE_HOST_FORBIDDEN',
        403,
      );
    }
  } else if (!isPublicDnsHostname(hostname)) {
    throw new McpPolicyError('MCP_PRIVATE_HOST_FORBIDDEN', 403);
  }

  if (parsed.protocol === 'http:' && !loopback) {
    throw new McpPolicyError('MCP_HTTPS_REQUIRED', 403);
  }
  if (parsed.protocol === 'http:' && loopback && !config.allowHttpLoopback) {
    throw new McpPolicyError('MCP_HTTP_LOOPBACK_DISABLED', 403);
  }
  if (parsed.protocol === 'https:' && parsed.port) {
    throw new McpPolicyError('MCP_UNSAFE_PORT', 403);
  }

  const layers = policy && Array.isArray(policy.layers)
    ? policy.layers
    : (config.globalPatterns.length ? [config.globalPatterns] : []);
  if (layers.some((patterns) => !hostMatchesPatterns(hostname, patterns))) {
    throw new McpPolicyError('MCP_HOST_NOT_ALLOWED', 403);
  }

  if (!family) parsed.hostname = hostname;
  parsed.hash = '';
  return Object.freeze({
    url: parsed.toString(),
    hostname,
    origin: parsed.origin,
    protocol: parsed.protocol,
    loopback,
  });
}

function settingsRestriction(settings, options) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null;
  if (!Object.prototype.hasOwnProperty.call(settings, 'mcpAllowedHosts')) return null;
  if (!Array.isArray(settings.mcpAllowedHosts)) {
    throw new McpPolicyError('MCP_SETTINGS_POLICY_INVALID', 503);
  }
  try {
    return parsePatternList(settings.mcpAllowedHosts, options);
  } catch (_error) {
    throw new McpPolicyError('MCP_SETTINGS_POLICY_INVALID', 503);
  }
}

function lookupFailure() {
  return new McpPolicyError(
    'MCP_POLICY_LOOKUP_FAILED',
    503,
    'MCP policy settings are unavailable',
  );
}

function normalizeOrganizationId(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  if (!normalized) throw new McpPolicyError('MCP_ORG_CONTEXT_INVALID', 400);
  return normalized;
}

function resolveOrganizationContext(options) {
  const splitContextProvided = (
    Object.prototype.hasOwnProperty.call(options, 'requestedOrganizationId')
    || Object.prototype.hasOwnProperty.call(options, 'activeOrganizationId')
  );
  if (!splitContextProvided) {
    const legacyOrganizationId = normalizeOrganizationId(options.organizationId);
    return {
      requestedOrganizationId: legacyOrganizationId,
      activeOrganizationId: legacyOrganizationId,
    };
  }
  const requestedOrganizationId = normalizeOrganizationId(options.requestedOrganizationId);
  const activeOrganizationId = normalizeOrganizationId(options.activeOrganizationId);
  if (requestedOrganizationId !== activeOrganizationId) {
    throw new McpPolicyError(
      'MCP_ORG_CONTEXT_UNVERIFIED',
      403,
      'MCP organization context was not verified',
    );
  }
  return { requestedOrganizationId, activeOrganizationId };
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function createMcpContextIdentityFingerprint({
  userId,
  requestedOrganizationId,
  activeOrganizationId,
}) {
  return fingerprint({
    version: 1,
    userId: userId == null ? null : String(userId),
    requestedOrganizationId,
    activeOrganizationId,
  });
}

function canonicalPolicyLayers(layers) {
  return (layers || []).map((layer) => (
    (layer || [])
      .map((pattern) => `${pattern.kind}:${pattern.hostname}`)
      .sort()
  ));
}

function finalizeResolvedPolicy(base, {
  layers,
  userRestricted,
  organizationRestrictionCount,
  lookupDegraded,
}) {
  const frozenLayers = Object.freeze(layers);
  const identity = createMcpContextIdentityFingerprint(base);
  return Object.freeze({
    ...base,
    layers: frozenLayers,
    userRestricted,
    organizationRestrictionCount,
    lookupDegraded,
    contextIdentityFingerprint: identity,
    policyContextFingerprint: fingerprint({
      version: 1,
      contextIdentityFingerprint: identity,
      layers: canonicalPolicyLayers(frozenLayers),
      lookupDegraded,
      production: base.config.production,
      allowHttpLoopback: base.config.allowHttpLoopback,
    }),
  });
}

async function resolveUserMcpPolicy(options = {}) {
  const {
    prisma,
    userId,
    env = process.env,
  } = options;
  const config = resolveMcpPolicyConfig(env);
  if (!config.valid) throwInvalidConfig(config);
  const {
    requestedOrganizationId,
    activeOrganizationId,
  } = resolveOrganizationContext(options);
  const layers = config.globalPatterns.length ? [config.globalPatterns] : [];
  const base = {
    config,
    userId: userId == null ? null : String(userId),
    requestedOrganizationId,
    activeOrganizationId,
    organizationId: activeOrganizationId,
  };
  if (!userId) {
    if (config.production || activeOrganizationId) throw lookupFailure();
    return finalizeResolvedPolicy(base, {
      layers,
      userRestricted: false,
      organizationRestrictionCount: 0,
      lookupDegraded: true,
    });
  }
  if (
    !prisma?.user
    || typeof prisma.user.findUnique !== 'function'
  ) {
    if (config.production || activeOrganizationId) throw lookupFailure();
    return finalizeResolvedPolicy(base, {
      layers,
      userRestricted: false,
      organizationRestrictionCount: 0,
      lookupDegraded: true,
    });
  }

  let user;
  try {
    user = await prisma.user.findUnique({
      where: { id: String(userId) },
      select: { settings: true },
    });
  } catch (_error) {
    if (config.production || activeOrganizationId) throw lookupFailure();
    return finalizeResolvedPolicy(base, {
      layers,
      userRestricted: false,
      organizationRestrictionCount: 0,
      lookupDegraded: true,
    });
  }
  if (!user && (config.production || activeOrganizationId)) throw lookupFailure();

  const patternOptions = { allowLoopback: !config.production };
  const userRestriction = settingsRestriction(user?.settings, patternOptions);
  if (userRestriction !== null) layers.push(userRestriction);
  let organizationRestrictionCount = 0;
  if (activeOrganizationId) {
    if (
      !prisma?.orgMembership
      || typeof prisma.orgMembership.findFirst !== 'function'
    ) {
      throw lookupFailure();
    }
    let membership;
    try {
      membership = await prisma.orgMembership.findFirst({
        where: {
          userId: String(userId),
          orgId: activeOrganizationId,
        },
        select: {
          organization: { select: { settings: true } },
        },
      });
    } catch (_error) {
      throw lookupFailure();
    }
    if (!membership) {
      throw new McpPolicyError('MCP_ORG_MEMBERSHIP_REQUIRED', 403);
    }
    const restriction = settingsRestriction(membership.organization?.settings, patternOptions);
    if (restriction !== null) {
      layers.push(restriction);
      organizationRestrictionCount = 1;
    }
  }
  return finalizeResolvedPolicy(base, {
    layers,
    userRestricted: userRestriction !== null,
    organizationRestrictionCount,
    lookupDegraded: false,
  });
}

async function authorizeMcpServerUrl(options = {}) {
  const {
    url,
    env = process.env,
  } = options;
  const resolvedPolicy = await resolveUserMcpPolicy(options);
  const checked = validateMcpServerUrl(url, { env, policy: resolvedPolicy });
  return Object.freeze({
    ...checked,
    requestedOrganizationId: resolvedPolicy.requestedOrganizationId,
    activeOrganizationId: resolvedPolicy.activeOrganizationId,
    contextIdentityFingerprint: resolvedPolicy.contextIdentityFingerprint,
    policyContextFingerprint: resolvedPolicy.policyContextFingerprint,
  });
}

module.exports = {
  MAX_POLICY_PATTERNS,
  McpPolicyError,
  normalizeHostname,
  parseHostPattern,
  parsePatternList,
  normalizeMcpAllowedHosts,
  hostMatchesPatterns,
  isLoopbackHostname,
  isPrivateOrReservedIp,
  resolveMcpPolicyConfig,
  validateMcpServerUrl,
  createMcpContextIdentityFingerprint,
  resolveUserMcpPolicy,
  authorizeMcpServerUrl,
};
