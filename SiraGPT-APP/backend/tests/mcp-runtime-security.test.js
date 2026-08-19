'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const mcp = require('../src/services/agent-harness/mcp-client');

function prodEnv(allowedHosts = '*.example.com') {
  return {
    NODE_ENV: 'production',
    SIRAGPT_MCP_ALLOWED_HOSTS: allowedHosts,
  };
}

function publicLookup() {
  return [{ address: '8.8.8.8', family: 4 }];
}

function runtimePrisma({
  settingsRef,
  server,
  serverRef = { current: server },
  lookupError = null,
  serverLookupError = null,
  serverReads = null,
  auditWrites = null,
  organizationSettingsById = null,
  membershipReads = null,
}) {
  const prisma = {
    mcpServer: {
      findMany: async () => (serverRef.current ? [serverRef.current] : []),
      findFirst: async ({ where }) => {
        if (Array.isArray(serverReads)) serverReads.push(where);
        if (serverLookupError) throw serverLookupError;
        const current = serverRef.current;
        if (
          !current
          || current.id !== where.id
          || current.userId !== where.userId
          || (where.enabled === true && current.enabled === false)
        ) {
          return null;
        }
        return current;
      },
    },
    user: {
      findUnique: async () => {
        if (lookupError) throw lookupError;
        return { settings: settingsRef.current };
      },
    },
    orgMembership: {
      findFirst: async ({ where }) => {
        if (Array.isArray(membershipReads)) membershipReads.push(where);
        if (lookupError) throw lookupError;
        if (
          !organizationSettingsById
          || !Object.prototype.hasOwnProperty.call(organizationSettingsById, where.orgId)
        ) {
          return null;
        }
        return {
          organization: {
            settings: organizationSettingsById[where.orgId],
          },
        };
      },
      findMany: async () => {
        if (lookupError) throw lookupError;
        return [];
      },
    },
  };
  if (Array.isArray(auditWrites)) {
    prisma.auditLog = {
      create: async ({ data }) => {
        auditWrites.push(data);
        return data;
      },
    };
  }
  return prisma;
}

test('mcp runtime exports a guarded SDK fetch surface', () => {
  assert.equal(typeof mcp.createPolicyFetch, 'function');
  assert.equal(typeof mcp.createPinnedDispatcher, 'function');
});

test('mcp transport authorization closure is pinned to its policy-context fingerprint', async () => {
  assert.equal(typeof mcp.createBoundPolicyAuthorize, 'function');
  let policyContextFingerprint = 'policy-personal-v1';
  const authorize = mcp.createBoundPolicyAuthorize({
    _authorize: async (rawUrl) => ({
      url: String(rawUrl),
      hostname: 'first.example.com',
      origin: 'https://first.example.com',
      loopback: false,
      contextIdentityFingerprint: 'identity-personal',
      policyContextFingerprint,
    }),
  }, 'policy-personal-v1');

  await assert.doesNotReject(() => authorize('https://first.example.com/mcp', 'transport'));
  policyContextFingerprint = 'policy-personal-v2';
  await assert.rejects(
    () => authorize('https://first.example.com/mcp', 'transport'),
    (error) => error && error.code === 'MCP_POLICY_CONTEXT_CHANGED',
  );
});

test('mcp guarded fetch pins the validated DNS record and never re-resolves inside fetch', async () => {
  let lookups = 0;
  const pins = [];
  let closes = 0;
  const dispatcher = {
    close: async () => {
      closes += 1;
    },
  };
  const guarded = mcp.createPolicyFetch({
    serverUrl: 'https://first.example.com/mcp',
    authorize: async (url) => ({
      url: String(url),
      hostname: new URL(url).hostname,
      origin: new URL(url).origin,
      loopback: false,
    }),
    lookup: async () => {
      lookups += 1;
      return lookups === 1
        ? [{ address: '93.184.216.34', family: 4 }]
        : [{ address: '169.254.169.254', family: 4 }];
    },
    createDispatcher: (pin) => {
      pins.push(pin);
      return dispatcher;
    },
    fetchImpl: async (url, init) => {
      assert.equal(String(url), 'https://first.example.com/mcp');
      assert.equal(init.dispatcher, dispatcher);
      return {
        status: 200,
        headers: new Headers(),
        url: String(url),
      };
    },
  });

  await guarded('https://first.example.com/mcp');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(lookups, 1, 'the HTTP connector must consume the validated pin, not resolve again');
  assert.deepEqual(
    pins.map(({ hostname, address, family }) => ({ hostname, address, family })),
    [{ hostname: 'first.example.com', address: '93.184.216.34', family: 4 }],
  );
  assert.equal(closes, 1, 'per-hop dispatcher must be drained after the response lifecycle starts');
});

test('mcp guarded fetch rejects a private DNS answer before creating a dispatcher or socket', async () => {
  let dispatcherCreates = 0;
  let fetches = 0;
  const guarded = mcp.createPolicyFetch({
    serverUrl: 'https://first.example.com/mcp',
    authorize: async (url) => ({
      url: String(url),
      hostname: new URL(url).hostname,
      origin: new URL(url).origin,
      loopback: false,
    }),
    lookup: async () => [{ address: '10.0.0.8', family: 4 }],
    createDispatcher: () => {
      dispatcherCreates += 1;
      return { close: async () => {} };
    },
    fetchImpl: async () => {
      fetches += 1;
      return { status: 200, headers: new Headers() };
    },
  });

  await assert.rejects(
    () => guarded('https://first.example.com/mcp'),
    (error) => error && error.code === 'MCP_PRIVATE_ADDRESS_DENIED',
  );
  assert.equal(dispatcherCreates, 0);
  assert.equal(fetches, 0);
});

test('mcp pinned dispatcher keeps the original hostname for TLS SNI and returns only the approved address', async () => {
  let connectorOptions;
  let agentOptions;
  const connector = () => {};
  const dispatcher = { close: async () => {} };
  const returned = mcp.createPinnedDispatcher({
    hostname: 'MCP.Example.com',
    address: '93.184.216.34',
    family: 4,
    buildConnector: (options) => {
      connectorOptions = options;
      return connector;
    },
    createAgent: (options) => {
      agentOptions = options;
      return dispatcher;
    },
  });

  assert.equal(returned, dispatcher);
  assert.equal(connectorOptions.servername, 'mcp.example.com');
  assert.equal(agentOptions.connect, connector);
  const single = await new Promise((resolve, reject) => {
    connectorOptions.lookup('mcp.example.com', {}, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    });
  });
  assert.deepEqual(single, { address: '93.184.216.34', family: 4 });
  const all = await new Promise((resolve, reject) => {
    connectorOptions.lookup('mcp.example.com', { all: true }, (error, records) => {
      if (error) reject(error);
      else resolve(records);
    });
  });
  assert.deepEqual(all, [{ address: '93.184.216.34', family: 4 }]);
});

test('mcp guarded fetch reaches a real socket only through the validated pin', async (t) => {
  let hostHeader = null;
  const server = http.createServer((req, res) => {
    hostHeader = req.headers.host;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('pinned');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const serverUrl = `http://mcp-rebind.invalid:${port}/mcp`;
  let lookups = 0;
  const guarded = mcp.createPolicyFetch({
    serverUrl,
    authorize: async (url) => ({
      url: String(url),
      hostname: 'mcp-rebind.invalid',
      origin: new URL(url).origin,
      loopback: true,
    }),
    lookup: async () => {
      lookups += 1;
      return lookups === 1
        ? [{ address: '127.0.0.1', family: 4 }]
        : [{ address: '10.0.0.8', family: 4 }];
    },
  });

  const response = await guarded(serverUrl);
  assert.equal(await response.text(), 'pinned');
  assert.equal(lookups, 1);
  assert.equal(hostHeader, `mcp-rebind.invalid:${port}`);
});

test('mcp runtime revalidates stored URLs against current settings before every call', async () => {
  const settingsRef = {
    current: { mcpAllowedHosts: ['first.example.com'] },
  };
  const server = {
    id: 'server-1',
    userId: 'user-1',
    name: 'first',
    url: 'https://first.example.com/mcp',
    transport: 'streamable-http',
    headersEncrypted: null,
    updatedAt: new Date(),
    _lookup: async () => publicLookup(),
  };
  let toolCalls = 0;
  const client = {
    listTools: async () => ({
      tools: [{
        name: 'read',
        description: 'read',
        inputSchema: { type: 'object', properties: {} },
      }],
    }),
    callTool: async () => {
      toolCalls += 1;
      return { content: [{ type: 'text', text: 'ok' }] };
    },
    close: async () => {},
  };
  const prisma = runtimePrisma({ settingsRef, server });
  const loaded = await mcp.loadUserMcpTools({
    userId: 'user-1',
    prisma,
    env: prodEnv(),
    getClientImpl: async () => client,
  });
  assert.equal(loaded.errors.length, 0);
  assert.equal(loaded.tools.length, 1);

  settingsRef.current = { mcpAllowedHosts: ['second.example.com'] };
  await assert.rejects(
    () => loaded.tools[0].execute({}),
    (error) => error && error.code === 'MCP_HOST_NOT_ALLOWED',
  );
  assert.equal(toolCalls, 0, 'policy denial must happen before the cached client call');
});

test('mcp connection cache isolates personal, org A, and org B without closing other contexts', async (t) => {
  assert.equal(typeof mcp.getClient, 'function');
  mcp.resetForTests();
  t.after(() => mcp.resetForTests());

  const connects = [];
  const closes = [];
  const base = {
    id: 'server-context-cache',
    userId: 'user-1',
    url: 'https://first.example.com/mcp',
    transport: 'streamable-http',
    headersEncrypted: 'cipher-shared-row',
    updatedAt: new Date('2026-07-11T00:00:00.000Z'),
    _connectClient: async (server) => {
      const context = server._activeOrganizationId || 'personal';
      connects.push(context);
      return {
        context,
        close: async () => {
          closes.push(context);
        },
      };
    },
  };
  const personal = {
    ...base,
    _contextIdentityFingerprint: 'identity-personal',
    _policyContextFingerprint: 'policy-personal-v1',
    _requestedOrganizationId: null,
    _activeOrganizationId: null,
  };
  const orgA = {
    ...base,
    _contextIdentityFingerprint: 'identity-org-a',
    _policyContextFingerprint: 'policy-org-a-v1',
    _requestedOrganizationId: 'org-a',
    _activeOrganizationId: 'org-a',
  };
  const orgB = {
    ...base,
    _contextIdentityFingerprint: 'identity-org-b',
    _policyContextFingerprint: 'policy-org-b-v1',
    _requestedOrganizationId: 'org-b',
    _activeOrganizationId: 'org-b',
  };

  const personalClient = await mcp.getClient(personal);
  const orgAClient = await mcp.getClient(orgA);
  const orgBClient = await mcp.getClient(orgB);
  assert.notEqual(personalClient, orgAClient);
  assert.notEqual(orgAClient, orgBClient);
  assert.equal(await mcp.getClient({ ...personal }), personalClient);
  assert.deepEqual(connects, ['personal', 'org-a', 'org-b']);
  assert.deepEqual(closes, [], 'switching tenant contexts must not close concurrent context clients');
});

test('mcp connection cache closes only the stale policy generation in the same context', async (t) => {
  assert.equal(typeof mcp.getClient, 'function');
  mcp.resetForTests();
  t.after(() => mcp.resetForTests());

  const closes = [];
  let generation = 0;
  const base = {
    id: 'server-policy-cache',
    userId: 'user-1',
    url: 'https://first.example.com/mcp',
    transport: 'streamable-http',
    headersEncrypted: null,
    updatedAt: new Date('2026-07-11T00:00:00.000Z'),
    _contextIdentityFingerprint: 'identity-personal',
    _requestedOrganizationId: null,
    _activeOrganizationId: null,
    _connectClient: async () => {
      generation += 1;
      const id = generation;
      return {
        id,
        close: async () => {
          closes.push(id);
        },
      };
    },
  };

  const first = await mcp.getClient({
    ...base,
    _policyContextFingerprint: 'policy-personal-v1',
  });
  const second = await mcp.getClient({
    ...base,
    _policyContextFingerprint: 'policy-personal-v2',
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.notEqual(first, second);
  assert.deepEqual(closes, [1]);
  assert.equal(
    await mcp.getClient({ ...base, _policyContextFingerprint: 'policy-personal-v2' }),
    second,
  );
  assert.equal(generation, 2);
});

test('mcp runtime binds authorization closures to requested and verified org context', async () => {
  const server = {
    id: 'server-context-auth',
    userId: 'user-1',
    name: 'context',
    url: 'https://first.example.com/mcp',
    transport: 'streamable-http',
    enabled: true,
    headersEncrypted: null,
    updatedAt: new Date(),
    _lookup: async () => publicLookup(),
  };
  const membershipReads = [];
  const prisma = runtimePrisma({
    settingsRef: { current: { mcpAllowedHosts: ['first.example.com'] } },
    server,
    organizationSettingsById: {
      'org-a': { mcpAllowedHosts: ['first.example.com'] },
      'org-b': { mcpAllowedHosts: ['first.example.com'] },
    },
    membershipReads,
  });
  const seen = [];
  const client = {
    listTools: async () => ({
      tools: [{ name: 'read', inputSchema: { type: 'object', properties: {} } }],
    }),
  };
  const load = async (requestedOrganizationId, activeOrganizationId) => mcp.loadUserMcpTools({
    userId: 'user-1',
    requestedOrganizationId,
    activeOrganizationId,
    prisma,
    env: prodEnv(),
    getClientImpl: async (runtimeServer) => {
      seen.push({
        requestedOrganizationId: runtimeServer._requestedOrganizationId,
        activeOrganizationId: runtimeServer._activeOrganizationId,
        contextIdentityFingerprint: runtimeServer._contextIdentityFingerprint,
        policyContextFingerprint: runtimeServer._policyContextFingerprint,
      });
      return client;
    },
  });

  for (const context of [[null, null], ['org-a', 'org-a'], ['org-b', 'org-b']]) {
    const loaded = await load(...context);
    assert.equal(loaded.errors.length, 0);
    assert.equal(loaded.tools.length, 1);
  }

  assert.deepEqual(
    seen.map(({ requestedOrganizationId, activeOrganizationId }) => ({
      requestedOrganizationId,
      activeOrganizationId,
    })),
    [
      { requestedOrganizationId: null, activeOrganizationId: null },
      { requestedOrganizationId: 'org-a', activeOrganizationId: 'org-a' },
      { requestedOrganizationId: 'org-b', activeOrganizationId: 'org-b' },
    ],
  );
  assert.equal(new Set(seen.map((entry) => entry.contextIdentityFingerprint)).size, 3);
  assert.equal(new Set(seen.map((entry) => entry.policyContextFingerprint)).size, 3);
  assert.deepEqual(membershipReads, [
    { userId: 'user-1', orgId: 'org-a' },
    { userId: 'user-1', orgId: 'org-b' },
  ]);
});

test('mcp runtime fails closed when an explicitly requested org was not verified upstream', async () => {
  const server = {
    id: 'server-invalid-org',
    userId: 'user-1',
    name: 'invalid-org',
    url: 'https://first.example.com/mcp',
    transport: 'streamable-http',
    enabled: true,
    headersEncrypted: null,
    updatedAt: new Date(),
    _lookup: async () => publicLookup(),
  };
  const auditWrites = [];
  let connects = 0;
  const loaded = await mcp.loadUserMcpTools({
    userId: 'user-1',
    requestedOrganizationId: 'org-requested',
    activeOrganizationId: null,
    prisma: runtimePrisma({
      settingsRef: { current: { mcpAllowedHosts: ['first.example.com'] } },
      server,
      organizationSettingsById: {
        'org-requested': { mcpAllowedHosts: ['first.example.com'] },
      },
      auditWrites,
    }),
    env: prodEnv(),
    getClientImpl: async () => {
      connects += 1;
      return {
        listTools: async () => ({
          tools: [{ name: 'must-not-load', inputSchema: { type: 'object' } }],
        }),
      };
    },
  });

  assert.equal(connects, 0);
  assert.equal(loaded.tools.length, 0);
  assert.equal(loaded.errors.length, 1);
  assert.equal(auditWrites.length, 1);
  assert.equal(auditWrites[0].metadata.phase, 'discovery');
  assert.equal(auditWrites[0].metadata.reason, 'MCP_ORG_CONTEXT_UNVERIFIED');
});

test('mcp runtime rotates the cached client when effective policy changes but still allows the host', async (t) => {
  assert.equal(typeof mcp.getClient, 'function');
  mcp.resetForTests();
  t.after(() => mcp.resetForTests());

  const settingsRef = {
    current: { mcpAllowedHosts: ['first.example.com', 'api.example.com'] },
  };
  let connects = 0;
  const closes = [];
  const server = {
    id: 'server-policy-rotation',
    userId: 'user-1',
    name: 'policy-rotation',
    url: 'https://first.example.com/mcp',
    transport: 'streamable-http',
    enabled: true,
    headersEncrypted: null,
    updatedAt: new Date('2026-07-11T00:00:00.000Z'),
    _lookup: async () => publicLookup(),
    _connectClient: async () => {
      connects += 1;
      const id = connects;
      return {
        listTools: async () => ({
          tools: [{ name: 'read', inputSchema: { type: 'object', properties: {} } }],
        }),
        callTool: async () => ({
          content: [{ type: 'text', text: `client-${id}` }],
        }),
        close: async () => {
          closes.push(id);
        },
      };
    },
  };
  const prisma = runtimePrisma({ settingsRef, server });
  const loaded = await mcp.loadUserMcpTools({
    userId: 'user-1',
    requestedOrganizationId: null,
    activeOrganizationId: null,
    prisma,
    env: prodEnv(),
  });
  assert.equal(loaded.tools.length, 1);
  assert.equal(connects, 1);

  settingsRef.current = { mcpAllowedHosts: ['first.example.com'] };
  const result = await loaded.tools[0].execute({});
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result.text, 'client-2');
  assert.equal(connects, 2);
  assert.deepEqual(closes, [1]);
});

test('mcp runtime re-fetches the server before each call and replaces updated credentials/client', async () => {
  const initial = {
    id: 'server-live',
    userId: 'user-1',
    name: 'live',
    url: 'https://first.example.com/mcp',
    transport: 'streamable-http',
    enabled: true,
    headersEncrypted: 'cipher-old',
    updatedAt: new Date('2026-07-11T00:00:00.000Z'),
    _lookup: async () => publicLookup(),
  };
  const serverRef = { current: initial };
  const serverReads = [];
  const dropped = [];
  const seenCredentials = [];
  let oldCalls = 0;
  let newCalls = 0;
  const oldClient = {
    listTools: async () => ({
      tools: [{ name: 'read', inputSchema: { type: 'object', properties: {} } }],
    }),
    callTool: async () => {
      oldCalls += 1;
      return { content: [{ type: 'text', text: 'old' }] };
    },
  };
  const newClient = {
    listTools: oldClient.listTools,
    callTool: async () => {
      newCalls += 1;
      return { content: [{ type: 'text', text: 'new' }] };
    },
  };
  const prisma = runtimePrisma({
    settingsRef: { current: { mcpAllowedHosts: ['first.example.com'] } },
    server: initial,
    serverRef,
    serverReads,
  });
  const loaded = await mcp.loadUserMcpTools({
    userId: 'user-1',
    prisma,
    env: prodEnv(),
    getClientImpl: async (server) => {
      seenCredentials.push(server.headersEncrypted);
      return server.headersEncrypted === 'cipher-new' ? newClient : oldClient;
    },
    dropClientImpl: (server) => {
      dropped.push({
        id: server.id,
        updatedAt: new Date(server.updatedAt).toISOString(),
      });
    },
  });
  assert.equal(loaded.tools.length, 1);

  serverRef.current = {
    ...initial,
    headersEncrypted: 'cipher-new',
    updatedAt: new Date('2026-07-11T00:01:00.000Z'),
  };
  const result = await loaded.tools[0].execute({});

  assert.equal(result.text, 'new');
  assert.equal(oldCalls, 0);
  assert.equal(newCalls, 1);
  assert.equal(serverReads.length, 1);
  assert.deepEqual(serverReads[0], {
    id: 'server-live',
    userId: 'user-1',
    enabled: true,
  });
  assert.deepEqual(seenCredentials, ['cipher-old', 'cipher-new']);
  assert.deepEqual(dropped, [{
    id: 'server-live',
    updatedAt: '2026-07-11T00:00:00.000Z',
  }]);
});

test('mcp runtime invalidates the cached client when a server is disabled or deleted', async () => {
  for (const nextValue of [null, { enabled: false }]) {
    const initial = {
      id: 'server-disabled',
      userId: 'user-1',
      name: 'disabled',
      url: 'https://first.example.com/mcp',
      transport: 'streamable-http',
      enabled: true,
      headersEncrypted: null,
      updatedAt: new Date('2026-07-11T00:00:00.000Z'),
      _lookup: async () => publicLookup(),
    };
    const serverRef = { current: initial };
    let toolCalls = 0;
    let drops = 0;
    const client = {
      listTools: async () => ({
        tools: [{ name: 'read', inputSchema: { type: 'object', properties: {} } }],
      }),
      callTool: async () => {
        toolCalls += 1;
        return { content: [{ type: 'text', text: 'must-not-run' }] };
      },
    };
    const loaded = await mcp.loadUserMcpTools({
      userId: 'user-1',
      prisma: runtimePrisma({
        settingsRef: { current: { mcpAllowedHosts: ['first.example.com'] } },
        server: initial,
        serverRef,
      }),
      env: prodEnv(),
      getClientImpl: async () => client,
      dropClientImpl: () => {
        drops += 1;
      },
    });
    assert.equal(loaded.tools.length, 1);
    serverRef.current = nextValue ? { ...initial, ...nextValue } : null;

    await assert.rejects(
      () => loaded.tools[0].execute({}),
      (error) => error && error.code === 'MCP_SERVER_DISABLED',
    );
    assert.equal(toolCalls, 0);
    assert.equal(drops, 1);
  }
});

test('mcp runtime re-resolves DNS at call time and blocks rebinding before tool execution', async () => {
  const settingsRef = {
    current: { mcpAllowedHosts: ['first.example.com'] },
  };
  let addresses = publicLookup();
  const server = {
    id: 'server-rebind',
    userId: 'user-1',
    name: 'first',
    url: 'https://first.example.com/mcp',
    transport: 'streamable-http',
    headersEncrypted: null,
    updatedAt: new Date(),
    _lookup: async () => addresses,
  };
  let toolCalls = 0;
  const auditWrites = [];
  const client = {
    listTools: async () => ({
      tools: [{ name: 'read', inputSchema: { type: 'object', properties: {} } }],
    }),
    callTool: async () => {
      toolCalls += 1;
      return { content: [{ type: 'text', text: 'ok' }] };
    },
    close: async () => {},
  };
  const loaded = await mcp.loadUserMcpTools({
    userId: 'user-1',
    prisma: runtimePrisma({ settingsRef, server, auditWrites }),
    env: prodEnv(),
    getClientImpl: async () => client,
  });
  assert.equal(loaded.tools.length, 1);

  addresses = [{ address: '169.254.169.254', family: 4 }];
  await assert.rejects(
    () => loaded.tools[0].execute({}),
    /private|loopback|metadata|reserved/i,
  );
  assert.equal(toolCalls, 0);
  assert.equal(auditWrites.length, 1);
  assert.equal(auditWrites[0].action, 'mcp_server_policy_denied');
  assert.equal(auditWrites[0].metadata.phase, 'call');
  assert.equal(auditWrites[0].metadata.reason, 'MCP_PRIVATE_ADDRESS_DENIED');
  assert.doesNotMatch(
    JSON.stringify(auditWrites),
    /first\.example\.com|169\.254\.169\.254|authorization/i,
  );
});

test('mcp runtime fails closed without exposing lookup failures in production discovery', async () => {
  const marker = 'postgresql://user:secret@private-db.internal/app';
  const server = {
    id: 'server-1',
    userId: 'user-1',
    name: 'private-name',
    url: 'https://first.example.com/mcp',
    transport: 'streamable-http',
    headersEncrypted: null,
    updatedAt: new Date(),
    _lookup: async () => publicLookup(),
  };
  const loaded = await mcp.loadUserMcpTools({
    userId: 'user-1',
    prisma: runtimePrisma({
      settingsRef: { current: null },
      server,
      lookupError: new Error(marker),
    }),
    env: prodEnv(),
    getClientImpl: async () => assert.fail('must not connect'),
  });
  assert.equal(loaded.tools.length, 0);
  assert.equal(loaded.errors.length, 1);
  assert.match(loaded.errors[0].error, /policy settings are unavailable/i);
  assert.doesNotMatch(JSON.stringify(loaded), /postgresql|secret|private-db/i);
});

test('mcp runtime redacts transport URLs and headers from discovery errors and logs', async (t) => {
  const settingsRef = {
    current: { mcpAllowedHosts: ['first.example.com'] },
  };
  const server = {
    id: 'server-redact',
    userId: 'user-1',
    name: 'first',
    url: 'https://first.example.com/mcp',
    transport: 'streamable-http',
    headersEncrypted: null,
    updatedAt: new Date(),
    _lookup: async () => publicLookup(),
  };
  const marker = 'Authorization: Bearer runtime-secret';
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  t.after(() => {
    console.warn = originalWarn;
  });

  const loaded = await mcp.loadUserMcpTools({
    userId: 'user-1',
    prisma: runtimePrisma({ settingsRef, server }),
    env: prodEnv(),
    getClientImpl: async () => ({
      listTools: async () => {
        throw new Error(`request to https://first.example.com/mcp failed; ${marker}`);
      },
    }),
  });

  assert.equal(loaded.tools.length, 0);
  assert.equal(loaded.errors.length, 1);
  assert.equal(loaded.errors[0].error, 'mcp server unavailable');
  assert.doesNotMatch(
    JSON.stringify({ loaded, warnings }),
    /first\.example\.com|authorization|runtime-secret/i,
  );
});

test('mcp guarded SDK fetch rejects cross-origin redirects before forwarding stored headers', async () => {
  const requests = [];
  const fakeFetch = async (url, init) => {
    requests.push({ url: String(url), headers: init.headers });
    return {
      status: 302,
      headers: new Headers({ location: 'https://attacker.example.net/steal' }),
      url: String(url),
    };
  };
  const guarded = mcp.createPolicyFetch({
    serverUrl: 'https://first.example.com/mcp',
    authorize: async (url) => ({
      url: String(url),
      hostname: new URL(url).hostname,
      origin: new URL(url).origin,
      loopback: false,
    }),
    lookup: async () => publicLookup(),
    fetchImpl: fakeFetch,
  });

  await assert.rejects(
    () => guarded('https://first.example.com/mcp', {
      headers: { authorization: 'Bearer should-not-cross-origin' },
    }),
    (error) => error && error.code === 'MCP_REDIRECT_ORIGIN_FORBIDDEN',
  );
  assert.equal(requests.length, 1, 'redirect target must never receive a request');
});

test('mcp guarded SDK fetch validates the final response origin exposed by the SDK fetch', async () => {
  const guarded = mcp.createPolicyFetch({
    serverUrl: 'https://first.example.com/mcp',
    authorize: async (url) => ({
      url: String(url),
      hostname: new URL(url).hostname,
      origin: new URL(url).origin,
      loopback: false,
    }),
    lookup: async () => publicLookup(),
    fetchImpl: async () => ({
      status: 200,
      headers: new Headers(),
      url: 'https://attacker.example.net/final',
    }),
  });

  await assert.rejects(
    () => guarded('https://first.example.com/mcp'),
    (error) => error && error.code === 'MCP_FINAL_ORIGIN_FORBIDDEN',
  );
});
