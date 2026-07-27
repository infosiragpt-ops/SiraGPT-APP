'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { TOOLS } = require('../src/services/codex/build-tools');
const { executeCodexWebFetch } = require('../src/services/codex/web-fetch');
const {
  discoverProjectMcpTools,
  executeMcpCall,
  executeMcpList,
  resolveConfigHeaders,
} = require('../src/services/codex/mcp-tools');
const { namespaceToolNames } = require('../src/services/agent-harness/mcp-client');

test('web_fetch reuses the hardened fetch path with offline DNS/fetch injectables', async () => {
  const seen = [];
  const dispatcher = { marker: 'pinned' };
  const result = await executeCodexWebFetch({
    url: 'https://docs.example.com/guide',
    maxChars: 2_000,
  }, {
    lookup: async (host) => {
      assert.equal(host, 'docs.example.com');
      return [{ address: '93.184.216.34', family: 4 }];
    },
    createDispatcher: (host, addresses) => {
      assert.equal(host, 'docs.example.com');
      assert.deepEqual(addresses, [{ address: '93.184.216.34', family: 4 }]);
      return dispatcher;
    },
    fetchImpl: async (url, init) => {
      seen.push({
        url,
        redirect: init.redirect,
        dispatcher: init.dispatcher,
        pinnedAddresses: init.pinnedAddresses,
      });
      return new Response('hello from docs', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    },
  });
  assert.equal(result.isError, false);
  assert.match(result.observation, /hello from docs/);
  assert.deepEqual(seen, [{
    url: 'https://docs.example.com/guide',
    redirect: 'manual',
    dispatcher,
    pinnedAddresses: [{ address: '93.184.216.34', family: 4 }],
  }]);
});

test('web_fetch blocks loopback and validates explicit caps before network access', async () => {
  let fetched = false;
  const blocked = await TOOLS.web_fetch.execute({ url: 'http://127.0.0.1/admin' }, {
    fetchImpl: async () => {
      fetched = true;
      throw new Error('must not fetch');
    },
  });
  assert.equal(blocked.isError, true);
  assert.match(blocked.summary, /web_fetch falló/);
  assert.equal(fetched, false);

  const invalidCap = await TOOLS.web_fetch.execute({
    url: 'https://example.com',
    maxChars: 20,
  }, {});
  assert.equal(invalidCap.isError, true);
  assert.match(invalidCap.summary, /maxChars inválido/);
});

function mcpRunner(config) {
  return {
    async readFile(_project, path) {
      assert.equal(path, '.sira/mcp.json');
      return { content: JSON.stringify(config) };
    },
  };
}

test('MCP project config discovers namespaced tools and isolates one broken server', async () => {
  const config = {
    servers: {
      docs: { url: 'https://docs.example.com/mcp' },
      broken: { url: 'https://broken.example.com/mcp' },
    },
  };
  const ctx = {
    runner: mcpRunner(config),
    project: 'project-mcp',
    env: { NODE_ENV: 'test' },
    mcpDiscoverServerTools: async (server) => {
      if (server.name === 'broken') throw new Error('offline test failure');
      const [name] = namespaceToolNames('docs', ['echo']);
      return [{
        name,
        description: 'Echo from MCP',
        parameters: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
        execute: async (args) => ({ text: `echo:${args.value}` }),
      }];
    },
  };
  const discovered = await discoverProjectMcpTools(ctx);
  assert.equal(discovered.tools.length, 1);
  assert.equal(discovered.tools[0].name, 'mcp__docs__echo');
  assert.equal(discovered.errors.length, 1);
  assert.equal(discovered.errors[0].server, 'broken');

  const listed = await executeMcpList({}, ctx);
  assert.equal(listed.isError, false);
  assert.match(listed.observation, /mcp__docs__echo/);
  assert.match(listed.observation, /broken/);

  const called = await executeMcpCall({
    tool: 'mcp__docs__echo',
    arguments: { value: 'ok' },
  }, ctx);
  assert.equal(called.isError, false);
  assert.match(called.observation, /echo:ok/);
});

test('MCP policy rejects private servers without taking down valid config handling', async () => {
  let discoveryCalls = 0;
  const ctx = {
    runner: mcpRunner({
      servers: {
        private: { url: 'http://127.0.0.1:3333/mcp' },
      },
    }),
    project: 'project-private',
    env: { NODE_ENV: 'test' },
    mcpDiscoverServerTools: async () => {
      discoveryCalls += 1;
      return [];
    },
  };
  const result = await discoverProjectMcpTools(ctx);
  assert.equal(result.tools.length, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].error, /MCP server blocked|MCP_|private|loopback|HTTP/i);
  assert.equal(discoveryCalls, 0);
});

test('MCP header references are bound to one server URL and project', () => {
  const binding = JSON.stringify({
    docs: {
      url: 'https://docs.example.com/mcp',
      projects: ['project-mcp'],
      headers: { Authorization: 'CODEX_MCP_DOCS_TOKEN' },
    },
  });
  assert.deepEqual(
    resolveConfigHeaders(
      { headers: { Authorization: '${CODEX_MCP_DOCS_TOKEN}' } },
      {
        CODEX_MCP_DOCS_TOKEN: 'secret-value',
        CODEX_MCP_SECRET_BINDINGS: binding,
      },
      {
        slug: 'docs',
        project: 'project-mcp',
        url: 'https://docs.example.com/mcp',
      },
    ),
    { Authorization: 'secret-value' },
  );
  assert.throws(
    () => resolveConfigHeaders(
      { headers: { Authorization: '${DATABASE_URL}' } },
      { DATABASE_URL: 'postgres://secret', CODEX_MCP_SECRET_BINDINGS: binding },
      {
        slug: 'docs',
        project: 'project-mcp',
        url: 'https://docs.example.com/mcp',
      },
    ),
    /CODEX_MCP_/,
  );
  assert.throws(
    () => resolveConfigHeaders(
      { headers: { Authorization: '${CODEX_MCP_DOCS_TOKEN}' } },
      {
        CODEX_MCP_DOCS_TOKEN: 'secret-value',
        CODEX_MCP_SECRET_BINDINGS: binding,
      },
      {
        slug: 'docs',
        project: 'other-project',
        url: 'https://docs.example.com/mcp',
      },
    ),
    /no autoriza este proyecto/,
  );
  assert.throws(
    () => resolveConfigHeaders(
      { headers: { Authorization: '${CODEX_MCP_DOCS_TOKEN}' } },
      {
        CODEX_MCP_DOCS_TOKEN: 'secret-value',
        CODEX_MCP_SECRET_BINDINGS: binding,
      },
      {
        slug: 'docs',
        project: 'project-mcp',
        url: 'https://evil.example/mcp',
      },
    ),
    /no coincide con la URL/,
  );
});
