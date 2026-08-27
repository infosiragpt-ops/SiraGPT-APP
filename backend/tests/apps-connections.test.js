'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  APP_IDS,
  STATUSES,
  publicManifest,
  listManifests,
  redactSecrets,
  assertNoSecrets,
  classifyBundle,
  mapHttpStatus,
  executeTool,
  disconnectApp,
  upsertFromOAuth,
  listUserApps,
  buildModelPrompt,
  githubSecretRef,
} = require('../src/services/apps');

const SECRET = 'gho_THIS_MUST_NEVER_LEAVE_THE_VAULT_1234567890';

function memoryPrisma() {
  const connections = new Map();
  const github = new Map();
  const social = new Map();
  const audits = [];
  return {
    audits,
    appConnection: {
      findUnique: async ({ where }) => {
        if (where.id) return [...connections.values()].find((row) => row.id === where.id) || null;
        const key = `${where.userId_appId.userId}:${where.userId_appId.appId}`;
        return connections.get(key) || null;
      },
      findMany: async ({ where }) => [...connections.values()].filter((row) => row.userId === where.userId),
      upsert: async ({ where, create, update }) => {
        const key = `${where.userId_appId.userId}:${where.userId_appId.appId}`;
        const current = connections.get(key);
        const row = current
          ? { ...current, ...update, updatedAt: new Date() }
          : { id: `app-${create.appId}`, ...create, createdAt: new Date(), updatedAt: new Date() };
        connections.set(key, row);
        return row;
      },
      update: async ({ where, data }) => {
        const current = [...connections.values()].find((row) => row.id === where.id);
        if (!current) return null;
        Object.assign(current, data, { updatedAt: new Date() });
        return current;
      },
      delete: async ({ where }) => {
        for (const [key, row] of connections) {
          if (row.id === where.id) connections.delete(key);
        }
      },
    },
    githubAccount: {
      findUnique: async ({ where }) => {
        if (where.id) return github.get(where.id) || [...github.values()].find((row) => row.id === where.id) || null;
        return [...github.values()].find((row) => row.userId === where.userId) || null;
      },
      deleteMany: async ({ where }) => {
        for (const [key, row] of github) {
          if (row.id === where.id || row.userId === where.userId) github.delete(key);
        }
      },
    },
    socialConnection: {
      findUnique: async ({ where }) => {
        if (where.id) return social.get(where.id) || null;
        const key = `${where.userId_platform.userId}:${where.userId_platform.platform}`;
        return social.get(key) || null;
      },
      findMany: async ({ where }) => [...social.values()].filter((row) => row.userId === where.userId),
      deleteMany: async ({ where }) => {
        for (const [key, row] of social) {
          if (row.id === where.id) social.delete(key);
        }
      },
    },
    auditLog: {
      create: async (args) => {
        audits.push(args.data || args);
        return { id: `audit-${audits.length}` };
      },
    },
    seedGithub(userId) {
      const row = {
        id: 'gh-1',
        userId,
        login: 'luis',
        scope: 'repo read:user',
        encryptedTokens: JSON.stringify({
          accessToken: SECRET,
          refreshToken: null,
          scope: 'repo read:user',
          expiresAt: Date.now() + 86_400_000,
        }),
      };
      github.set(row.id, row);
      return row;
    },
  };
}

const identityVault = {
  openProviderTokens(blob) {
    return typeof blob === 'string' ? JSON.parse(blob) : blob;
  },
  sealProviderTokens(bundle) {
    return JSON.stringify(bundle);
  },
};

test('apps registry exposes github, linkedin and x without provider brand leakage in public tools', () => {
  assert.deepEqual(APP_IDS, ['github', 'linkedin', 'x']);
  const names = listManifests().map((app) => app.id);
  assert.deepEqual(names, APP_IDS);
  for (const app of listManifests()) {
    const pub = publicManifest(app);
    assert.equal(pub.auth.startsWith('oauth'), true);
    assert.ok(pub.tools.some((tool) => tool.kind === 'read'));
    assert.doesNotMatch(JSON.stringify(pub), /OpenRouter|DeepSeek/i);
  }
});

test('redactSecrets strips tokens from tool payloads', () => {
  const dirty = {
    items: [{ title: 'ok' }],
    accessToken: SECRET,
    nested: { Authorization: `Bearer ${SECRET}`, note: 'fine' },
  };
  const clean = redactSecrets(dirty);
  assert.equal(clean.accessToken, '[redacted]');
  assert.equal(clean.nested.Authorization, '[redacted]');
  assert.equal(clean.items[0].title, 'ok');
  assert.doesNotMatch(JSON.stringify(clean), /gho_/);
  assert.throws(() => assertNoSecrets({ accessToken: SECRET }));
});

test('health status mapping covers expired, revoked, missing scopes and degraded', () => {
  const app = listManifests().find((entry) => entry.id === 'github');
  assert.equal(classifyBundle({ accessToken: SECRET, scopes: ['read:user'] }, app).status, STATUSES.CONNECTED);
  assert.equal(classifyBundle({
    accessToken: SECRET,
    scopes: ['read:user'],
    expiresAt: Date.now() - 1000,
  }, app).status, STATUSES.EXPIRED);
  assert.equal(classifyBundle({ accessToken: SECRET, scopes: [] }, app).status, STATUSES.MISSING_SCOPES);
  assert.equal(mapHttpStatus(401, ['read:user'], app), STATUSES.REVOKED);
  assert.equal(mapHttpStatus(503, ['read:user'], app), STATUSES.DEGRADED);
  assert.equal(mapHttpStatus(200, ['read:user'], app), STATUSES.CONNECTED);
});

test('gateway executes a GitHub read without leaking the vault token', async () => {
  const prisma = memoryPrisma();
  const account = prisma.seedGithub('user-1');
  await upsertFromOAuth(prisma, {
    userId: 'user-1',
    appId: 'github',
    sourceId: account.id,
    accountLabel: 'luis',
    scopes: ['repo', 'read:user'],
  });
  const result = await executeTool(prisma, {
    userId: 'user-1',
    toolName: 'github_list_repos',
    vault: identityVault,
    fetchImpl: async (url, init) => {
      assert.match(String(url), /api\.github\.com\/user\/repos/);
      assert.match(String(init.headers.Authorization), /Bearer /);
      assert.equal(String(init.headers.Authorization).includes(SECRET), true);
      return new Response(JSON.stringify([
        { full_name: 'luis/sira', private: true, html_url: 'https://github.com/luis/sira', description: 'x', language: 'js', updated_at: '2026-01-01' },
      ]), { status: 200 });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.app, 'github');
  assert.equal(result.tool, 'github_list_repos');
  assert.equal(result.result.items[0].fullName, 'luis/sira');
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /gho_/);
  assert.doesNotMatch(serialized, /THIS_MUST_NEVER_LEAVE/);
  assert.equal(serialized.includes(SECRET), false);
});

test('write tools require approval and disconnect revokes then drops the secret', async () => {
  const prisma = memoryPrisma();
  const account = prisma.seedGithub('user-2');
  await upsertFromOAuth(prisma, {
    userId: 'user-2',
    appId: 'github',
    sourceId: account.id,
    scopes: ['repo', 'read:user'],
  });
  const denied = await executeTool(prisma, {
    userId: 'user-2',
    toolName: 'github_create_issue',
    args: { owner: 'luis', repo: 'sira', title: 'Bug' },
    approved: false,
    vault: identityVault,
    fetchImpl: async () => {
      throw new Error('provider should not be called without approval');
    },
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.result.error, 'approval_required');

  let revoked = false;
  const out = await disconnectApp(prisma, {
    userId: 'user-2',
    appId: 'github',
    vault: identityVault,
    env: { GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'csecret' },
    fetchImpl: async (url, init) => {
      assert.match(String(url), /api\.github\.com\/applications\/cid\/token/);
      assert.equal(init.method, 'DELETE');
      const body = JSON.parse(init.body);
      assert.equal(body.access_token, SECRET);
      revoked = true;
      return new Response(null, { status: 204 });
    },
  });
  assert.equal(out.disconnected, true);
  assert.equal(revoked, true);
  assert.equal(await prisma.githubAccount.findUnique({ where: { id: 'gh-1' } }), null);
  const listed = await listUserApps(prisma, 'user-2', { probe: false });
  assert.equal(listed.length, 0);
});

test('linkedin and x read tools execute without putting tokens in the result', async () => {
  const prisma = memoryPrisma();
  prisma.socialConnection.findUnique = async ({ where }) => {
    if (where.id === 'li-1' || where.userId_platform?.platform === 'linkedin') {
      return {
        id: 'li-1',
        userId: 'user-4',
        platform: 'linkedin',
        accountId: 'li-user',
        accountName: 'Luis',
        accessToken: JSON.stringify({ accessToken: SECRET, scopes: ['openid', 'profile'] }),
        scopes: ['openid', 'profile'],
      };
    }
    if (where.id === 'x-1' || where.userId_platform?.platform === 'x') {
      return {
        id: 'x-1',
        userId: 'user-4',
        platform: 'x',
        accountId: '42',
        accountName: '@luis',
        accessToken: JSON.stringify({ accessToken: SECRET, scopes: ['users.read', 'tweet.read'] }),
        scopes: ['users.read', 'tweet.read'],
      };
    }
    return null;
  };
  await upsertFromOAuth(prisma, {
    userId: 'user-4',
    appId: 'linkedin',
    sourceId: 'li-1',
    scopes: ['openid', 'profile'],
  });
  await upsertFromOAuth(prisma, {
    userId: 'user-4',
    appId: 'x',
    sourceId: 'x-1',
    scopes: ['users.read', 'tweet.read'],
  });

  const linkedin = await executeTool(prisma, {
    userId: 'user-4',
    toolName: 'linkedin_read_profile',
    vault: identityVault,
    fetchImpl: async (url) => {
      assert.match(String(url), /linkedin\.com\/v2\/userinfo/);
      return new Response(JSON.stringify({ name: 'Luis', email: 'luis@example.com' }), { status: 200 });
    },
  });
  const xMentions = await executeTool(prisma, {
    userId: 'user-4',
    toolName: 'x_list_mentions',
    vault: identityVault,
    fetchImpl: async (url) => {
      assert.match(String(url), /api\.x\.com\/2\/users\/42\/mentions/);
      return new Response(JSON.stringify({ data: [{ id: '1', text: 'hola', author_id: '9' }] }), { status: 200 });
    },
  });
  assert.equal(linkedin.ok, true);
  assert.equal(linkedin.result.name, 'Luis');
  assert.equal(xMentions.ok, true);
  assert.equal(xMentions.result.items[0].text, 'hola');
  assert.equal(JSON.stringify(linkedin).includes(SECRET), false);
  assert.equal(JSON.stringify(xMentions).includes(SECRET), false);
});

test('model prompt only exposes app, connection_id and available_tools', async () => {
  const prisma = memoryPrisma();
  const account = prisma.seedGithub('user-3');
  const row = await upsertFromOAuth(prisma, {
    userId: 'user-3',
    appId: 'github',
    sourceId: account.id,
    scopes: ['repo', 'read:user'],
  });
  const prompt = buildModelPrompt([row]);
  assert.match(prompt, /github/);
  assert.match(prompt, /connection_id=/);
  assert.match(prompt, /github_list_repos/);
  assert.doesNotMatch(prompt, /gho_|accessToken|Bearer /);
  assert.equal(row.secretRef, githubSecretRef(account.id));
  assert.equal(JSON.stringify(row).includes(SECRET), false);
});

test('mentioned apps prompt attaches healthy tools and asks to connect the rest', async () => {
  const { buildUserAppsPrompt } = require('../src/services/apps');
  const prisma = memoryPrisma();
  const account = prisma.seedGithub('user-mention');
  await upsertFromOAuth(prisma, {
    userId: 'user-mention',
    appId: 'github',
    sourceId: account.id,
    scopes: ['repo', 'read:user'],
  });
  const prompt = await buildUserAppsPrompt(prisma, 'user-mention', {
    prompt: 'Usa @GitHub y @LinkedIn',
  });
  assert.match(prompt, /github_list_repos/);
  assert.match(prompt, /LinkedIn no está conectada/);
  assert.doesNotMatch(prompt, /gho_|THIS_MUST_NEVER/);
});
