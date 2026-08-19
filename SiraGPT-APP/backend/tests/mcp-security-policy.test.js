'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let policy = null;
try {
  policy = require('../src/services/agent-harness/mcp-policy');
} catch (_error) {
  // RED until the policy module is introduced.
}

test('mcp security policy exposes one normalized URL authorization surface', () => {
  assert.ok(policy, 'mcp-policy module must exist');
  assert.equal(typeof policy.resolveMcpPolicyConfig, 'function');
  assert.equal(typeof policy.validateMcpServerUrl, 'function');
  assert.equal(typeof policy.resolveUserMcpPolicy, 'function');
  assert.equal(typeof policy.authorizeMcpServerUrl, 'function');
});

function prodEnv(allowedHosts = 'mcp.example.com') {
  return {
    NODE_ENV: 'production',
    SIRAGPT_MCP_ALLOWED_HOSTS: allowedHosts,
  };
}

function assertPolicyCode(fn, code) {
  assert.throws(fn, (error) => error && error.code === code);
}

test('mcp security policy requires HTTPS and an explicit production global allowlist', () => {
  const missing = policy.resolveMcpPolicyConfig({ NODE_ENV: 'production' });
  assert.equal(missing.valid, false);
  assert.ok(missing.errors.some((entry) => entry.code === 'MCP_ALLOWED_HOSTS_REQUIRED'));

  const env = prodEnv('mcp.example.com');
  const accepted = policy.validateMcpServerUrl('https://MCP.Example.com:443/mcp', { env });
  assert.equal(accepted.hostname, 'mcp.example.com');
  assert.equal(accepted.url, 'https://mcp.example.com/mcp');

  assertPolicyCode(
    () => policy.validateMcpServerUrl('http://mcp.example.com/mcp', { env }),
    'MCP_HTTPS_REQUIRED',
  );
  assertPolicyCode(
    () => policy.validateMcpServerUrl('https://mcp.example.com:8443/mcp', { env }),
    'MCP_UNSAFE_PORT',
  );
});

test('mcp security policy allows HTTP only for explicit nonproduction loopback', () => {
  const disabled = { NODE_ENV: 'development' };
  assertPolicyCode(
    () => policy.validateMcpServerUrl('http://localhost:4310/mcp', { env: disabled }),
    'MCP_HTTP_LOOPBACK_DISABLED',
  );

  const enabled = {
    NODE_ENV: 'development',
    SIRAGPT_MCP_ALLOW_HTTP: '1',
  };
  assert.equal(
    policy.validateMcpServerUrl('http://localhost:4310/mcp', { env: enabled }).url,
    'http://localhost:4310/mcp',
  );
  assert.equal(
    policy.validateMcpServerUrl('http://127.0.0.1:4310/mcp', { env: enabled }).hostname,
    '127.0.0.1',
  );
  assert.equal(
    policy.validateMcpServerUrl('http://[0:0:0:0:0:0:0:1]:4310/mcp', { env: enabled }).url,
    'http://[::1]:4310/mcp',
  );
  assertPolicyCode(
    () => policy.validateMcpServerUrl('http://mcp.example.com/mcp', { env: enabled }),
    'MCP_HTTPS_REQUIRED',
  );
  assertPolicyCode(
    () => policy.validateMcpServerUrl('http://localhost:4310/mcp', {
      env: {
        ...enabled,
        NODE_ENV: 'production',
        SIRAGPT_MCP_ALLOW_HTTP: '0',
        SIRAGPT_MCP_ALLOWED_HOSTS: 'mcp.example.com',
      },
    }),
    'MCP_HTTP_LOOPBACK_DISABLED',
  );
});

test('mcp security policy wildcard matching is label-bound and never includes the apex', () => {
  const env = prodEnv('*.tools.example.com,exact.example.net');
  assert.equal(
    policy.validateMcpServerUrl('https://one.tools.example.com/mcp', { env }).hostname,
    'one.tools.example.com',
  );
  assert.equal(
    policy.validateMcpServerUrl('https://deep.one.tools.example.com/mcp', { env }).hostname,
    'deep.one.tools.example.com',
  );
  for (const rejected of [
    'https://tools.example.com/mcp',
    'https://badtools.example.com/mcp',
    'https://one.tools.example.com.attacker.net/mcp',
    'https://sub.exact.example.net/mcp',
  ]) {
    assertPolicyCode(
      () => policy.validateMcpServerUrl(rejected, { env }),
      'MCP_HOST_NOT_ALLOWED',
    );
  }
});

test('mcp security policy normalizes Unicode IDNs and punycode before comparison', () => {
  const unicodeConfigured = prodEnv('münich.de');
  const fromPunycode = policy.validateMcpServerUrl('https://xn--mnich-kva.de/mcp', {
    env: unicodeConfigured,
  });
  assert.equal(fromPunycode.hostname, 'xn--mnich-kva.de');

  const punycodeConfigured = prodEnv('xn--mnich-kva.de');
  const fromUnicode = policy.validateMcpServerUrl('https://münich.de/mcp', {
    env: punycodeConfigured,
  });
  assert.equal(fromUnicode.hostname, 'xn--mnich-kva.de');
  assert.equal(fromUnicode.url, 'https://xn--mnich-kva.de/mcp');
});

test('mcp security policy rejects unsafe wildcard, userinfo, IP tricks, and private/reserved hosts', () => {
  for (const allowedHosts of ['*.com', '*.co.uk', '*example.com', '127.0.0.1', '[::1]']) {
    const config = policy.resolveMcpPolicyConfig(prodEnv(allowedHosts));
    assert.equal(config.valid, false, `${allowedHosts} must be invalid`);
  }

  const env = prodEnv('mcp.example.com');
  assertPolicyCode(
    () => policy.validateMcpServerUrl('https://user:password@mcp.example.com/mcp', { env }),
    'MCP_USERINFO_FORBIDDEN',
  );
  for (const rawUrl of [
    'https://@mcp.example.com/mcp',
    'https://:@mcp.example.com/mcp',
  ]) {
    assertPolicyCode(
      () => policy.validateMcpServerUrl(rawUrl, { env }),
      'MCP_USERINFO_FORBIDDEN',
    );
  }
  for (const rawUrl of [
    'https://10.0.0.1/mcp',
    'https://169.254.169.254/mcp',
    'https://192.0.2.10/mcp',
    'https://[2001:db8::1]/mcp',
    'https://2130706433/mcp',
    'https://127.1/mcp',
    'https://0x7f000001/mcp',
    'https://0177.0.0.1/mcp',
    'https://[::ffff:127.0.0.1]/mcp',
  ]) {
    assertPolicyCode(
      () => policy.validateMcpServerUrl(rawUrl, {
        env: prodEnv('mcp.example.com'),
      }),
      'MCP_PRIVATE_HOST_FORBIDDEN',
    );
  }
});

function policyPrisma({
  userSettings = null,
  organizationSettings = [],
  lookupError = null,
} = {}) {
  return {
    user: {
      findUnique: async () => {
        if (lookupError) throw lookupError;
        return { settings: userSettings };
      },
    },
    orgMembership: {
      findMany: async () => {
        if (lookupError) throw lookupError;
        return organizationSettings.map((settings) => ({
          organization: { settings },
        }));
      },
    },
  };
}

test('mcp security policy applies only global and user restrictions for personal context', async () => {
  const env = prodEnv('*.example.com,api.vendor.com');
  const prisma = policyPrisma({
    userSettings: {
      mcpAllowedHosts: ['tools.example.com', 'api.vendor.com', 'evil.com'],
    },
    organizationSettings: [
      { mcpAllowedHosts: ['*.example.com', 'evil.com'] },
      { mcpAllowedHosts: ['tools.example.com'] },
      { unrelated: true },
    ],
  });

  const resolved = await policy.resolveUserMcpPolicy({ prisma, userId: 'user-1', env });
  assert.equal(resolved.layers.length, 2);
  assert.equal(resolved.organizationRestrictionCount, 0);
  assert.equal(resolved.organizationId, null);
  assert.equal(
    policy.validateMcpServerUrl('https://tools.example.com/mcp', {
      env,
      policy: resolved,
    }).hostname,
    'tools.example.com',
  );
  assert.equal(
    policy.validateMcpServerUrl('https://api.vendor.com/mcp', {
      env,
      policy: resolved,
    }).hostname,
    'api.vendor.com',
  );
  for (const rejected of ['https://evil.com/mcp', 'https://other.example.com/mcp']) {
    assertPolicyCode(
      () => policy.validateMcpServerUrl(rejected, { env, policy: resolved }),
      'MCP_HOST_NOT_ALLOWED',
    );
  }
});

test('mcp security policy verifies and applies only the explicit active organization', async () => {
  const env = prodEnv('*.example.com,api.vendor.com');
  const membershipReads = [];
  const prisma = {
    user: {
      findUnique: async () => ({
        settings: { mcpAllowedHosts: ['tools.example.com', 'api.vendor.com'] },
      }),
    },
    orgMembership: {
      findFirst: async ({ where }) => {
        membershipReads.push(where);
        if (where.orgId !== 'org-active' || where.userId !== 'user-1') return null;
        return {
          organization: {
            settings: { mcpAllowedHosts: ['tools.example.com'] },
          },
        };
      },
      findMany: async () => assert.fail('all memberships must never constrain an active context'),
    },
  };

  const resolved = await policy.resolveUserMcpPolicy({
    prisma,
    userId: 'user-1',
    organizationId: 'org-active',
    env,
  });
  assert.equal(resolved.layers.length, 3);
  assert.equal(resolved.organizationRestrictionCount, 1);
  assert.equal(resolved.organizationId, 'org-active');
  assert.deepEqual(membershipReads, [{ userId: 'user-1', orgId: 'org-active' }]);
  assert.equal(
    policy.validateMcpServerUrl('https://tools.example.com/mcp', {
      env,
      policy: resolved,
    }).hostname,
    'tools.example.com',
  );
  assertPolicyCode(
    () => policy.validateMcpServerUrl('https://api.vendor.com/mcp', {
      env,
      policy: resolved,
    }),
    'MCP_HOST_NOT_ALLOWED',
  );

  await assert.rejects(
    () => policy.resolveUserMcpPolicy({
      prisma,
      userId: 'user-1',
      organizationId: 'org-other',
      env,
    }),
    (error) => error && error.code === 'MCP_ORG_MEMBERSHIP_REQUIRED',
  );
});

test('mcp policy fingerprints isolate personal, org A, and org B contexts', async () => {
  const env = prodEnv('*.example.com');
  const membershipReads = [];
  const prisma = {
    user: {
      findUnique: async () => ({
        settings: { mcpAllowedHosts: ['tools.example.com', 'api.example.com'] },
      }),
    },
    orgMembership: {
      findFirst: async ({ where }) => {
        membershipReads.push(where);
        if (!['org-a', 'org-b'].includes(where.orgId)) return null;
        return {
          organization: {
            // Deliberately identical settings: tenant identity itself must keep
            // connection/auth closures isolated, even when policy values match.
            settings: { mcpAllowedHosts: ['tools.example.com'] },
          },
        };
      },
    },
  };

  const personal = await policy.resolveUserMcpPolicy({
    prisma,
    userId: 'user-1',
    requestedOrganizationId: null,
    activeOrganizationId: null,
    env,
  });
  const orgA = await policy.resolveUserMcpPolicy({
    prisma,
    userId: 'user-1',
    requestedOrganizationId: 'org-a',
    activeOrganizationId: 'org-a',
    env,
  });
  const orgB = await policy.resolveUserMcpPolicy({
    prisma,
    userId: 'user-1',
    requestedOrganizationId: 'org-b',
    activeOrganizationId: 'org-b',
    env,
  });

  for (const resolved of [personal, orgA, orgB]) {
    assert.match(resolved.contextIdentityFingerprint, /^[a-f0-9]{64}$/);
    assert.match(resolved.policyContextFingerprint, /^[a-f0-9]{64}$/);
  }
  assert.equal(new Set([
    personal.contextIdentityFingerprint,
    orgA.contextIdentityFingerprint,
    orgB.contextIdentityFingerprint,
  ]).size, 3);
  assert.equal(new Set([
    personal.policyContextFingerprint,
    orgA.policyContextFingerprint,
    orgB.policyContextFingerprint,
  ]).size, 3);
  assert.deepEqual(membershipReads, [
    { userId: 'user-1', orgId: 'org-a' },
    { userId: 'user-1', orgId: 'org-b' },
  ]);
});

test('mcp policy fingerprint changes when an effective policy layer changes', async () => {
  const env = prodEnv('*.example.com');
  let settings = { mcpAllowedHosts: ['tools.example.com', 'api.example.com'] };
  const prisma = {
    user: {
      findUnique: async () => ({ settings }),
    },
  };

  const before = await policy.resolveUserMcpPolicy({
    prisma,
    userId: 'user-1',
    requestedOrganizationId: null,
    activeOrganizationId: null,
    env,
  });
  settings = { mcpAllowedHosts: ['tools.example.com'] };
  const after = await policy.resolveUserMcpPolicy({
    prisma,
    userId: 'user-1',
    requestedOrganizationId: null,
    activeOrganizationId: null,
    env,
  });

  assert.equal(before.contextIdentityFingerprint, after.contextIdentityFingerprint);
  assert.notEqual(before.policyContextFingerprint, after.policyContextFingerprint);
});

test('mcp policy never downgrades an explicitly requested but unverified org to personal', async () => {
  const env = prodEnv('*.example.com');
  let userReads = 0;
  let membershipReads = 0;
  const prisma = {
    user: {
      findUnique: async () => {
        userReads += 1;
        return { settings: null };
      },
    },
    orgMembership: {
      findFirst: async () => {
        membershipReads += 1;
        return {
          organization: { settings: null },
        };
      },
    },
  };

  await assert.rejects(
    () => policy.resolveUserMcpPolicy({
      prisma,
      userId: 'user-1',
      requestedOrganizationId: 'org-requested',
      activeOrganizationId: null,
      env,
    }),
    (error) => error && error.code === 'MCP_ORG_CONTEXT_UNVERIFIED',
  );
  assert.equal(userReads, 0);
  assert.equal(membershipReads, 0);

  await assert.rejects(
    () => policy.resolveUserMcpPolicy({
      prisma,
      userId: 'user-1',
      requestedOrganizationId: 'org-requested',
      activeOrganizationId: 'org-other',
      env,
    }),
    (error) => error && error.code === 'MCP_ORG_CONTEXT_UNVERIFIED',
  );
  assert.equal(userReads, 0);
  assert.equal(membershipReads, 0);
});

test('mcp policy independently re-verifies membership for a matching verified org', async () => {
  const env = prodEnv('*.example.com');
  let membershipReads = 0;
  const prisma = {
    user: { findUnique: async () => ({ settings: null }) },
    orgMembership: {
      findFirst: async ({ where }) => {
        membershipReads += 1;
        assert.deepEqual(where, { userId: 'user-1', orgId: 'org-active' });
        return null;
      },
    },
  };

  await assert.rejects(
    () => policy.resolveUserMcpPolicy({
      prisma,
      userId: 'user-1',
      requestedOrganizationId: 'org-active',
      activeOrganizationId: 'org-active',
      env,
    }),
    (error) => error && error.code === 'MCP_ORG_MEMBERSHIP_REQUIRED',
  );
  assert.equal(membershipReads, 1);
});

test('mcp security policy never degrades an unverified active organization to personal context', async () => {
  await assert.rejects(
    () => policy.resolveUserMcpPolicy({
      prisma: {
        user: {
          findUnique: async () => {
            throw new Error('settings unavailable');
          },
        },
        orgMembership: {
          findFirst: async () => assert.fail('membership must not be trusted after lookup failure'),
        },
      },
      userId: 'user-1',
      organizationId: 'org-active',
      env: {
        NODE_ENV: 'test',
        SIRAGPT_MCP_ALLOWED_HOSTS: '*.example.com',
      },
    }),
    (error) => error && error.code === 'MCP_POLICY_LOOKUP_FAILED',
  );
});

test('mcp security policy treats an explicit empty active user or organization list as deny-all', async () => {
  const env = prodEnv('mcp.example.com');
  const userResolved = await policy.resolveUserMcpPolicy({
    prisma: policyPrisma({ userSettings: { mcpAllowedHosts: [] } }),
    userId: 'user-1',
    env,
  });
  assertPolicyCode(
    () => policy.validateMcpServerUrl('https://mcp.example.com/mcp', {
      env,
      policy: userResolved,
    }),
    'MCP_HOST_NOT_ALLOWED',
  );

  const orgResolved = await policy.resolveUserMcpPolicy({
    prisma: {
      user: { findUnique: async () => ({ settings: null }) },
      orgMembership: {
        findFirst: async () => ({
          organization: { settings: { mcpAllowedHosts: [] } },
        }),
      },
    },
    userId: 'user-1',
    organizationId: 'org-active',
    env,
  });
  assertPolicyCode(
    () => policy.validateMcpServerUrl('https://mcp.example.com/mcp', {
      env,
      policy: orgResolved,
    }),
    'MCP_HOST_NOT_ALLOWED',
  );
});

test('mcp security policy re-reads settings so a policy change disables a stored URL immediately', async () => {
  const env = prodEnv('*.example.com');
  let settings = { mcpAllowedHosts: ['first.example.com'] };
  let userLookups = 0;
  const prisma = {
    user: {
      findUnique: async () => {
        userLookups += 1;
        return { settings };
      },
    },
    orgMembership: { findMany: async () => [] },
  };

  await assert.doesNotReject(() => policy.authorizeMcpServerUrl({
    prisma,
    userId: 'user-1',
    url: 'https://first.example.com/mcp',
    env,
  }));
  settings = { mcpAllowedHosts: ['second.example.com'] };
  await assert.rejects(
    () => policy.authorizeMcpServerUrl({
      prisma,
      userId: 'user-1',
      url: 'https://first.example.com/mcp',
      env,
    }),
    (error) => error && error.code === 'MCP_HOST_NOT_ALLOWED',
  );
  assert.equal(userLookups, 2);
});

test('mcp security policy fails closed on settings lookup errors in production', async () => {
  const prisma = policyPrisma({ lookupError: new Error('database URL and secret must not escape') });
  await assert.rejects(
    () => policy.authorizeMcpServerUrl({
      prisma,
      userId: 'user-1',
      url: 'https://mcp.example.com/mcp',
      env: prodEnv('mcp.example.com'),
    }),
    (error) => (
      error
      && error.code === 'MCP_POLICY_LOOKUP_FAILED'
      && error.status === 503
      && !/database|secret|url/i.test(error.message)
    ),
  );
});

test('mcp security policy keeps nonproduction usable on settings lookup errors without bypassing global policy', async () => {
  const prisma = policyPrisma({ lookupError: new Error('db unavailable') });
  const env = {
    NODE_ENV: 'test',
    SIRAGPT_MCP_ALLOWED_HOSTS: 'mcp.example.com',
  };
  const accepted = await policy.authorizeMcpServerUrl({
    prisma,
    userId: 'user-1',
    url: 'https://mcp.example.com/mcp',
    env,
  });
  assert.equal(accepted.hostname, 'mcp.example.com');
  await assert.rejects(
    () => policy.authorizeMcpServerUrl({
      prisma,
      userId: 'user-1',
      url: 'https://other.example.com/mcp',
      env,
    }),
    (error) => error && error.code === 'MCP_HOST_NOT_ALLOWED',
  );
});
