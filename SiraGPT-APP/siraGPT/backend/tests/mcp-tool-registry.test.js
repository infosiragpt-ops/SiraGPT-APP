const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  CallToolResultSchema,
  ListToolsResultSchema,
  ToolSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const {
  createMcpRequestContext,
  createMcpToolRegistry,
  normalizeMcpToolRegistryError,
  resolveMcpToolAllowlist,
} = require('../src/services/connectors/mcp-tool-registry');

function fakePrisma({ ownsProject = true, doc = null } = {}) {
  const calls = [];
  return {
    calls,
    project: {
      findFirst: async (args) => {
        calls.push(['project.findFirst', args]);
        return ownsProject ? { id: args.where.id } : null;
      },
    },
    projectDocument: {
      findFirst: async (args) => {
        calls.push(['projectDocument.findFirst', args]);
        if (!doc) return null;
        return doc;
      },
    },
  };
}

function fakeRegistry(options = {}) {
  return createMcpToolRegistry({
    env: options.env || {},
    prisma: options.prisma || fakePrisma(),
    createGitHubConnector: () => ({
      getStatus: () => ({
        configured: true,
        tokenSource: 'GITHUB_CODEX_TOKEN',
        resilience: { retry: { limit: 2 }, throttle: { maxRetries: 2 } },
      }),
      getRepositoryContext: async (params) => ({
        repository: { fullName: params.repository },
        branch: params.branch || 'main',
        auth: { configured: true, tokenSource: 'GITHUB_CODEX_TOKEN' },
      }),
    }),
    rag: {
      retrieve: async (userId, collection, query, k, opts) => [{
        userId,
        collection,
        query,
        k,
        opts,
        text: 'retrieved private chunk',
        score: 0.9,
      }],
    },
    projectMemory: {
      listMemory: async (projectId, { limit }) => [{ id: 'm1', projectId, fact: 'stable fact', limit }],
    },
  });
}

function userContext(overrides = {}) {
  return createMcpRequestContext({
    user: { id: 'u1', tenantId: 'tenant-1', ...overrides.user },
    allowlist: overrides.allowlist,
    tenantScope: overrides.tenantScope,
  }, {});
}

function parseStructured(result) {
  const parsed = CallToolResultSchema.safeParse(result);
  assert.equal(parsed.success, true);
  return parsed.data.structuredContent;
}

describe('MCP connector hub registry', () => {
  test('lists only approved tools and validates manifests with the MCP SDK schema', () => {
    assert.deepEqual(resolveMcpToolAllowlist({ MCP_CONNECTOR_ALLOWLIST: 'rag.retrieve,bad,document.preview' }), [
      'rag.retrieve',
      'document.preview',
    ]);

    const registry = fakeRegistry({
      env: { MCP_CONNECTOR_ALLOWLIST: 'github.codex.status,rag.retrieve' },
    });
    const list = registry.listTools(userContext());
    assert.equal(ListToolsResultSchema.safeParse(list).success, true);
    assert.deepEqual(list.tools.map((tool) => tool.name), ['github.codex.status', 'rag.retrieve']);
    for (const tool of list.tools) {
      assert.equal(ToolSchema.safeParse(tool).success, true);
      assert.equal(tool.annotations.readOnlyHint, true);
      assert.equal(tool.annotations.destructiveHint, false);
      assert.equal(tool._meta['siragpt.io/approvedInternalTool'], true);
    }
  });

  test('requires authenticated tenant scope and configured allowlist before invocation', async () => {
    const registry = fakeRegistry();

    await assert.rejects(
      () => registry.callTool('github.codex.status', {}, { allowlist: ['github.codex.status'] }),
      (error) => {
        const normalized = normalizeMcpToolRegistryError(error);
        assert.equal(normalized.status, 401);
        assert.equal(normalized.body.code, 'mcp_auth_required');
        return true;
      },
    );

    await assert.rejects(
      () => registry.callTool('github.codex.status', {}, userContext({
        tenantScope: { userId: 'u1', tenantId: '' },
        allowlist: ['github.codex.status'],
      })),
      (error) => {
        const normalized = normalizeMcpToolRegistryError(error);
        assert.equal(normalized.status, 403);
        assert.equal(normalized.body.code, 'mcp_tenant_scope_required');
        return true;
      },
    );

    await assert.rejects(
      () => registry.callTool('rag.retrieve', { collection: 'c', query: 'q' }, userContext({
        allowlist: ['github.codex.status'],
      })),
      (error) => {
        const normalized = normalizeMcpToolRegistryError(error);
        assert.equal(normalized.status, 403);
        assert.equal(normalized.body.code, 'mcp_tool_not_allowed');
        return true;
      },
    );
  });

  test('rejects browser-provided tokens before tool execution', async () => {
    const registry = fakeRegistry();
    await assert.rejects(
      () => registry.callTool('github.codex.repository_context', {
        repository: 'SiraGPT-ORg/siraGPT',
        githubToken: 'ghp_secret',
      }, userContext({ allowlist: ['github.codex.repository_context'] })),
      (error) => {
        const normalized = normalizeMcpToolRegistryError(error);
        assert.equal(normalized.status, 400);
        assert.equal(normalized.body.code, 'browser_secret_rejected');
        assert.equal(JSON.stringify(normalized).includes('ghp_secret'), false);
        return true;
      },
    );
  });

  test('invokes GitHub status and RAG retrieve with server-side scoped context', async () => {
    const registry = fakeRegistry();

    const status = parseStructured(await registry.callTool('github.codex.status', {}, userContext({
      allowlist: ['github.codex.status'],
    })));
    assert.equal(status.github.configured, true);
    assert.equal(JSON.stringify(status).includes('ghp_secret'), false);
    assert.equal(status.tenant.id, 'tenant-1');

    const rag = parseStructured(await registry.callTool('rag.retrieve', {
      collection: 'github:SiraGPT-ORg/siraGPT:main',
      query: 'retry throttle',
      k: 3,
    }, userContext({ allowlist: ['rag.retrieve'] })));
    assert.equal(rag.hits.length, 1);
    assert.equal(rag.hits[0].userId, 'u1');
    assert.equal(rag.hits[0].k, 3);
    assert.equal(rag.hits[0].opts.useHybrid, true);
  });

  test('gates project memory and document preview by project ownership', async () => {
    const prisma = fakePrisma({
      ownsProject: true,
      doc: {
        id: 'd1',
        title: 'Spec',
        content: 'A'.repeat(500),
        updatedAt: new Date('2026-05-01T12:00:00Z'),
        meta: { kind: 'markdown' },
      },
    });
    const registry = fakeRegistry({ prisma });

    const memory = parseStructured(await registry.callTool('project.memory.list', {
      projectId: ' p1 ',
      limit: 5,
    }, userContext({ allowlist: ['project.memory.list'] })));
    assert.equal(memory.memory[0].fact, 'stable fact');
    assert.equal(memory.memory[0].limit, 5);
    assert.equal(memory.memory[0].projectId, 'p1');

    const preview = parseStructured(await registry.callTool('document.preview', {
      projectId: ' p1 ',
      docId: 'd1',
      maxChars: 120,
    }, userContext({ allowlist: ['document.preview'] })));
    assert.equal(preview.document.preview.length, 120);
    assert.equal(preview.document.truncated, true);
    assert.equal(preview.document.updatedAt, '2026-05-01T12:00:00.000Z');
    assert.ok(prisma.calls.some(([name]) => name === 'project.findFirst'));
    assert.ok(prisma.calls.some(([name]) => name === 'projectDocument.findFirst'));
    assert.ok(prisma.calls.some(([name, args]) => name === 'projectDocument.findFirst' && args.where.projectId === 'p1'));
  });

  test('denies project-scoped tools when ownership check fails', async () => {
    const registry = fakeRegistry({ prisma: fakePrisma({ ownsProject: false }) });
    await assert.rejects(
      () => registry.callTool('document.preview', {
        projectId: 'p2',
        docId: 'd1',
      }, userContext({ allowlist: ['document.preview'] })),
      (error) => {
        const normalized = normalizeMcpToolRegistryError(error);
        assert.equal(normalized.status, 404);
        assert.equal(normalized.body.code, 'mcp_project_not_found');
        return true;
      },
    );
  });
});
