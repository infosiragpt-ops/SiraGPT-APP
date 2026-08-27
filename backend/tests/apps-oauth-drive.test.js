'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  APP_IDS,
  STATUSES,
  SECRET_KINDS,
  listManifests,
  getManifest,
  normalizeAppId,
  healthTarget,
  executeTool,
  upsertFromOAuth,
  resolveMentionedApps,
  classifyMentions,
} = require('../src/services/apps');
const oauth = require('../src/services/apps/oauth');
const { CALLBACK_PATHS, getOnedriveCallbackURL, getGoogleServicesCallbackURL, getGoogleCallbackURL } = require('../src/config/oauth-url-policy');

const SECRET = 'ya29.DRIVE_TOKEN_MUST_NEVER_LEAVE_THE_VAULT_123456';
const MS_SECRET = 'EwBw.MSGRAPH_TOKEN_MUST_NEVER_LEAVE_THE_VAULT_abcdef';

const BASE_ENV = {
  NODE_ENV: 'test',
  FRONTEND_URL: 'http://localhost:3000',
  BACKEND_PUBLIC_URL: 'https://siragpt.com',
  MICROSOFT_CLIENT_ID: 'ms-client',
  MICROSOFT_CLIENT_SECRET: 'ms-secret',
  GOOGLE_CLIENT_ID: 'google-client.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'google-secret',
};

function identityVault() {
  return {
    openProviderTokens(blob) {
      return typeof blob === 'string' ? JSON.parse(blob) : blob;
    },
    sealProviderTokens(bundle) {
      return JSON.stringify(bundle);
    },
  };
}

function memoryPrisma() {
  const connections = new Map();
  const connectors = new Map();
  const users = new Map();
  return {
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
    },
    connectorAccount: {
      findUnique: async ({ where }) => {
        if (where.id) return [...connectors.values()].find((row) => row.id === where.id) || null;
        if (where.userId_provider) {
          return [...connectors.values()].find((row) => (
            row.userId === where.userId_provider.userId
            && row.provider === where.userId_provider.provider
          )) || null;
        }
        return null;
      },
      findMany: async ({ where }) => [...connectors.values()].filter((row) => {
        if (row.userId !== where.userId) return false;
        if (where.provider?.in) return where.provider.in.includes(row.provider);
        return true;
      }),
      upsert: async ({ where, create, update }) => {
        const existing = [...connectors.values()].find((row) => (
          row.userId === where.userId_provider.userId
          && row.provider === where.userId_provider.provider
        ));
        const row = existing
          ? { ...existing, ...update, updatedAt: new Date() }
          : { id: `conn-${create.provider}`, ...create, createdAt: new Date(), updatedAt: new Date() };
        connectors.set(row.id, row);
        return row;
      },
      updateMany: async ({ where, data }) => {
        for (const row of connectors.values()) {
          if (where.id && row.id !== where.id) continue;
          if (where.userId && row.userId !== where.userId) continue;
          if (where.provider && row.provider !== where.provider) continue;
          Object.assign(row, data);
        }
      },
    },
    user: {
      findUnique: async ({ where }) => users.get(where.id) || null,
      updateMany: async ({ where, data }) => {
        const row = users.get(where.id);
        if (row) Object.assign(row, data);
      },
    },
    auditLog: { create: async () => ({ id: 'audit-1' }) },
    seedConnector(userId, provider, accessToken, scopes) {
      const row = {
        id: `conn-${provider}`,
        userId,
        provider,
        accountLabel: provider === 'onedrive' ? 'Luis OneDrive' : 'infosiragpt@gmail.com',
        tokenEncrypted: JSON.stringify({ accessToken, scopes }),
        scopes,
        status: 'connected',
      };
      connectors.set(row.id, row);
      return row;
    },
    seedGoogleServices(userId, accessToken, scopes) {
      const row = {
        id: userId,
        googleServicesTokens: JSON.stringify({ accessToken, scopes }),
      };
      users.set(userId, row);
      return row;
    },
  };
}

test('registry lists onedrive and google-drive; Drive reuses google-services OAuth', () => {
  assert.deepEqual(APP_IDS, ['github', 'linkedin', 'x', 'onedrive', 'google-drive']);
  assert.equal(normalizeAppId('one-drive'), 'onedrive');
  assert.equal(normalizeAppId('gdrive'), 'google-drive');
  assert.equal(normalizeAppId('drive'), 'google-drive');
  assert.equal(normalizeAppId('google_drive'), 'google-drive');
  const one = getManifest('onedrive');
  assert.equal(one.connectPath, '/apps/connect/onedrive');
  assert.equal(one.callbackPath, CALLBACK_PATHS.onedrive);
  assert.deepEqual(one.tools.map((tool) => tool.name), [
    'onedrive_list',
    'onedrive_search',
    'onedrive_read_text',
    'onedrive_upload',
  ]);
  const gdrive = getManifest('google-drive');
  assert.equal(gdrive.connectPath, '/auth/google-services');
  assert.equal(gdrive.callbackPath, CALLBACK_PATHS.googleServices);
  assert.deepEqual(gdrive.tools.map((tool) => tool.name), [
    'gdrive_list',
    'gdrive_search',
    'gdrive_read_text',
    'gdrive_upload',
  ]);
  for (const app of listManifests()) {
    assert.doesNotMatch(JSON.stringify(app), /OpenRouter|DeepSeek|claude-|gpt-4/i);
  }
});

test('CALLBACK_PATHS.onedrive is registered and login Google callback is unchanged', () => {
  assert.equal(CALLBACK_PATHS.onedrive, '/api/apps/oauth/onedrive/callback');
  assert.equal(CALLBACK_PATHS.googleServices, '/api/auth/google-services/callback');
  assert.equal(CALLBACK_PATHS.google, '/api/auth/google/callback');
  assert.equal(CALLBACK_PATHS.gmail, '/api/auth/gmail/callback');
  assert.equal(
    getOnedriveCallbackURL(BASE_ENV),
    'https://siragpt.com/api/apps/oauth/onedrive/callback',
  );
  assert.equal(
    getGoogleServicesCallbackURL(BASE_ENV),
    'https://siragpt.com/api/auth/google-services/callback',
  );
  assert.equal(getGoogleCallbackURL(BASE_ENV), 'https://siragpt.com/api/auth/google/callback');
});

test('OneDrive OAuth start uses Microsoft consumers + PKCE and hides the secret', async () => {
  let signed;
  const out = await oauth.beginAuthorization({
    userId: 'u1',
    appId: 'onedrive',
    env: BASE_ENV,
    signState: async (payload) => {
      signed = payload;
      return 'signed-od';
    },
  });
  const url = new URL(out.url);
  assert.equal(out.app, 'onedrive');
  assert.match(url.origin, /login\.microsoftonline\.com/);
  assert.match(url.pathname, /\/consumers\/oauth2\/v2\.0\/authorize/);
  assert.equal(url.searchParams.get('client_id'), 'ms-client');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('code_challenge'));
  assert.equal(url.searchParams.has('code_verifier'), false);
  assert.equal(url.searchParams.has('client_secret'), false);
  assert.match(url.searchParams.get('redirect_uri'), /\/api\/apps\/oauth\/onedrive\/callback$/);
  assert.match(url.searchParams.get('scope'), /Files\.ReadWrite/);
  assert.match(url.searchParams.get('scope'), /offline_access/);
  assert.match(url.searchParams.get('scope'), /User\.Read/);
  assert.ok(signed.context.codeVerifier);
  assert.equal(signed.service, 'app_onedrive');
  assert.doesNotMatch(JSON.stringify(out), /ms-secret/);
});

test('Google Drive is not a second apps OAuth broker', async () => {
  await assert.rejects(
    () => oauth.beginAuthorization({ userId: 'u1', appId: 'google-drive', env: BASE_ENV }),
    (error) => {
      assert.equal(error.code, 'APP_UNKNOWN');
      return true;
    },
  );
  assert.deepEqual(oauth.FILE_APP_IDS, ['onedrive']);
});

test('missing Microsoft client credentials fail closed in Spanish', async () => {
  await assert.rejects(
    () => oauth.beginAuthorization({ userId: 'u1', appId: 'onedrive', env: { NODE_ENV: 'test' } }),
    (error) => {
      assert.equal(error.code, 'APP_PROVIDER_NOT_CONFIGURED');
      assert.match(error.message, /credenciales/i);
      return true;
    },
  );
});

test('OneDrive callback stores a sealed ConnectorAccount vault row', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), body: String(init?.body || '') });
    if (String(url).includes('/oauth2/v2.0/token')) {
      return new Response(JSON.stringify({
        access_token: MS_SECRET,
        refresh_token: 'ms-refresh',
        expires_in: 3600,
        scope: 'Files.ReadWrite offline_access User.Read',
        token_type: 'Bearer',
      }), { status: 200 });
    }
    if (String(url).endsWith('/me')) {
      return new Response(JSON.stringify({
        id: 'ms-user-1',
        displayName: 'Luis',
        userPrincipalName: 'luis@outlook.com',
      }), { status: 200 });
    }
    if (String(url).includes('/me/drive')) {
      return new Response(JSON.stringify({ id: 'drive-1', driveType: 'personal' }), { status: 200 });
    }
    throw new Error(`unexpected ${url}`);
  };
  const prisma = memoryPrisma();
  const vault = {
    sealProviderTokens: (bundle) => `sealed:${bundle.tokenType}:${(bundle.scopes || []).join(',')}`,
  };
  const result = await oauth.completeAuthorization({
    appId: 'onedrive',
    code: 'code-od',
    state: 'state-od',
    prisma,
    env: BASE_ENV,
    fetchImpl,
    verifyState: async () => ({ userId: 'u-od', context: { codeVerifier: 'verifier-1' } }),
    vault,
  });
  assert.equal(result.app, 'onedrive');
  assert.equal(result.userId, 'u-od');
  assert.equal(result.connection.provider, 'onedrive');
  assert.equal(result.connection.accountLabel, 'Luis');
  const tokenCall = requests.find((row) => row.url.includes('/token'));
  assert.match(tokenCall.body, /code_verifier=verifier-1/);
  const stored = await prisma.connectorAccount.findUnique({ where: { id: result.connection.id } });
  assert.match(stored.tokenEncrypted, /^sealed:/);
  assert.doesNotMatch(JSON.stringify(stored), new RegExp(MS_SECRET.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(MS_SECRET.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('health probes Graph /me/drive and Drive about.get', () => {
  assert.equal(healthTarget('onedrive').url, 'https://graph.microsoft.com/v1.0/me/drive');
  assert.equal(healthTarget('google-drive').url, 'https://www.googleapis.com/drive/v3/about?fields=user');
  assert.equal(healthTarget('github').url, 'https://api.github.com/user');
  assert.equal(healthTarget('x').url, 'https://api.x.com/2/users/me');
});

test('mention aliases attach OneDrive and Google Drive tools only when connected', () => {
  const ids = resolveMentionedApps('Abre @OneDrive y @Google-Drive y @gdrive', ['drive']);
  assert.deepEqual(ids.sort(), ['google-drive', 'onedrive']);
  const classified = classifyMentions(ids, [
    { id: 'c-od', appId: 'onedrive', status: STATUSES.CONNECTED },
  ]);
  assert.deepEqual(classified.attached.map((app) => app.id), ['onedrive']);
  assert.ok(classified.attached[0].tools.includes('onedrive_list'));
  assert.deepEqual(classified.needsConnect.map((app) => app.id), ['google-drive']);
  assert.doesNotMatch(JSON.stringify(classified), /token|Bearer /i);
});

test('onedrive and gdrive tools never leak vault tokens', async () => {
  const prisma = memoryPrisma();
  prisma.seedConnector('user-d', 'onedrive', MS_SECRET, ['Files.ReadWrite', 'offline_access', 'User.Read']);
  prisma.seedConnector('user-d', 'google_drive', SECRET, [
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/drive.file',
  ]);
  await upsertFromOAuth(prisma, {
    userId: 'user-d',
    appId: 'onedrive',
    sourceId: 'conn-onedrive',
    scopes: ['Files.ReadWrite', 'offline_access', 'User.Read'],
    secretKind: SECRET_KINDS.CONNECTOR_ACCOUNT,
  });
  await upsertFromOAuth(prisma, {
    userId: 'user-d',
    appId: 'google-drive',
    sourceId: 'conn-google_drive',
    scopes: ['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive.file'],
    secretKind: SECRET_KINDS.CONNECTOR_ACCOUNT,
  });

  const onedrive = await executeTool(prisma, {
    userId: 'user-d',
    toolName: 'onedrive_list',
    vault: identityVault(),
    fetchImpl: async (url, init) => {
      assert.match(String(url), /graph\.microsoft\.com\/v1\.0\/me\/drive/);
      assert.equal(String(init.headers.Authorization).includes(MS_SECRET), true);
      return new Response(JSON.stringify({
        value: [{ id: 'f1', name: 'notas.txt', size: 12, webUrl: 'https://1drv.ms/x', lastModifiedDateTime: '2026-01-01' }],
      }), { status: 200 });
    },
  });
  const gdrive = await executeTool(prisma, {
    userId: 'user-d',
    toolName: 'gdrive_search',
    args: { query: 'informe' },
    vault: identityVault(),
    fetchImpl: async (url, init) => {
      assert.match(String(url), /googleapis\.com\/drive\/v3\/files/);
      assert.equal(String(init.headers.Authorization).includes(SECRET), true);
      return new Response(JSON.stringify({
        files: [{ id: 'g1', name: 'informe.pdf', mimeType: 'application/pdf', webViewLink: 'https://drive.google.com/file/d/g1' }],
      }), { status: 200 });
    },
  });

  assert.equal(onedrive.ok, true);
  assert.equal(onedrive.result.items[0].name, 'notas.txt');
  assert.equal(gdrive.ok, true);
  assert.equal(gdrive.result.items[0].name, 'informe.pdf');
  const serialized = JSON.stringify({ onedrive, gdrive });
  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes(MS_SECRET), false);
  assert.doesNotMatch(serialized, /ya29\.|EwBw\./);
});

test('gdrive tools also open the existing User.googleServicesTokens vault', async () => {
  const prisma = memoryPrisma();
  prisma.seedGoogleServices('user-legacy', SECRET, [
    'https://www.googleapis.com/auth/drive.readonly',
  ]);
  await upsertFromOAuth(prisma, {
    userId: 'user-legacy',
    appId: 'google-drive',
    sourceId: 'user-legacy',
    secretKind: SECRET_KINDS.USER_GOOGLE_SERVICES,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  const listed = await executeTool(prisma, {
    userId: 'user-legacy',
    toolName: 'gdrive_list',
    vault: identityVault(),
    fetchImpl: async (_url, init) => {
      assert.equal(String(init.headers.Authorization).includes(SECRET), true);
      return new Response(JSON.stringify({ files: [{ id: 'g2', name: 'brief.md' }] }), { status: 200 });
    },
  });
  assert.equal(listed.ok, true);
  assert.equal(listed.result.items[0].name, 'brief.md');
  assert.equal(JSON.stringify(listed).includes(SECRET), false);
});

test('apps OAuth broker is OneDrive-only and does not steal social or login callbacks', () => {
  const appsRoute = fs.readFileSync(path.join(__dirname, '../src/routes/apps.js'), 'utf8');
  const registry = fs.readFileSync(path.join(__dirname, '../src/services/apps/registry.js'), 'utf8');
  const social = fs.readFileSync(path.join(__dirname, '../src/routes/social-posts.js'), 'utf8');
  const auth = fs.readFileSync(path.join(__dirname, '../src/routes/auth.js'), 'utf8');
  const policy = fs.readFileSync(path.join(__dirname, '../src/config/oauth-url-policy.js'), 'utf8');
  const linkedin = getManifest('linkedin');
  assert.deepEqual(linkedin.minScopes, ['openid', 'profile']);
  assert.deepEqual(linkedin.writeScopes, ['w_member_social']);
  assert.doesNotMatch(linkedin.minScopes.join(' '), /r_member_social/);
  assert.match(appsRoute, /\/connect\/:appId/);
  assert.match(appsRoute, /\/oauth\/:appId\/callback/);
  assert.match(registry, /\/api\/apps\/oauth\/onedrive\/callback/);
  assert.match(registry, /\/auth\/google-services/);
  assert.match(registry, /\/api\/auth\/google-services\/callback/);
  assert.doesNotMatch(registry, /\/api\/apps\/oauth\/google-drive/);
  assert.match(policy, /onedrive: '\/api\/apps\/oauth\/onedrive\/callback'/);
  assert.match(social, /\/oauth\/:platform\/callback/);
  assert.doesNotMatch(social, /onedrive|google-drive/);
  assert.match(auth, /router\.get\('\/google\/callback'/);
  assert.match(auth, /router\.get\('\/gmail\/callback'/);
  assert.match(auth, /router\.get\('\/google-services\/callback'/);
  assert.doesNotMatch(auth, /apps\/oauth\/google-drive/);
});
